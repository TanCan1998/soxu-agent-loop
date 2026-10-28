import { dataRoot } from "./config.mjs";
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessRequirement, submitRequirement, assessmentFailure } from './dashboard-intake.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const validText=x=>typeof x==='string' && x.trim().length>=10 && x.length<=6000;
const validId=x=>typeof x==='string' && /^[0-9a-f-]{36}$/.test(x);
// "无"/"暂无" is a statement that there is nothing to confirm, not a question.
const NO_UNKNOWNS = /^(?:无|暂无|没有|无需确认|无待确认项|none|null|n\/a)[。.！!]?$/i;
export function questions(assessment) {
  const raw=String(assessment?.unknowns || '').split(/\n+/).map(x=>x.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '').trim()).filter(x=>x && !NO_UNKNOWNS.test(x));
  const supplied=Array.isArray(assessment?.questions) ? assessment.questions : [];
  if(supplied.length===raw.length && raw.length) return supplied.map((q,i)=>({...q,text:raw[i]===q.text?q.text:raw[i]+" — "+q.text}));
  return [...raw.map(text=>({text,options:[]})),...supplied];
}
export function validateAnswers(assessment, answers) {
  const qs=questions(assessment);
  if (!Array.isArray(answers) || answers.length!==qs.length) throw fail('answers-required');
  return answers.map((a,i)=>{
    if (!a || !Array.isArray(a.selected) || a.selected.length>20 || typeof a.custom!=='string' || a.custom.length>400 || a.selected.some(x=>typeof x!=='string' || !qs[i].options.includes(x)) || (!a.selected.length && !a.custom.trim())) throw fail('answers-required');
    return {selected:[...new Set(a.selected)],custom:a.custom.trim()};
  });
}
export class DraftStore {
  constructor({root,assess=assessRequirement,submit=submitRequirement,onChange=()=>{}}) {
    this.root=root;this.path=join(dataRoot(root),'intake','drafts.json');this.assess=assess;this.submit=submit;this.onChange=onChange;this.items=[];this.busy=false;this.abort=null;this.serial=Promise.resolve();this.index=0;
    this.initialized=this.load();
  }
  async load(){
    try {const data=JSON.parse(await readFile(this.path,'utf8'));if(!Array.isArray(data.items)) throw Error('invalid-drafts');this.items=data.items;
      let changed=false;for(const d of this.items){if(d.status==='submitting'){d.status='unknown';d.error='提交中断，结果不确定。请先在 GitHub 核实，再解除锁定。';changed=true;}else if(d.status==='assessing'){d.status='draft';d.error='评估中断，请手动重新评估。';changed=true;}}
      if(changed) await this.persist();
    } catch(e){if(e.code!=='ENOENT') throw e;}
  }
  async persist(){const data=JSON.stringify({version:1,items:this.items});const path=this.path;this.serial=this.serial.then(async()=>{await mkdir(join(dataRoot(this.root),'intake'),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,data,{mode:0o600});await rename(tmp,path);});await this.serial;this.onChange();}
  state(){return {items:structuredClone(this.items),busy:this.busy};}
  item(id){if(!validId(id)) throw fail('invalid-id');const d=this.items.find(x=>x.id===id);if(!d) throw fail('draft-not-found',404);return d;}
  async save({id=null,requirement}){await this.initialized;if(this.busy) throw fail('intake-busy',409);if(!validText(requirement)) throw fail('invalid-requirement');let d;
    if(id){d=this.item(id);if(['unknown','submitting','submitted'].includes(d.status)) throw fail('draft-locked',409);if(d.requirement!==requirement.trim()){d.requirement=requirement.trim();d.status='draft';delete d.assessment;delete d.answers;delete d.error;}}
    else {if(this.items.length>=200) throw fail('draft-limit');d={id:randomUUID(),requirement:requirement.trim(),status:'draft'};this.items.push(d);}await this.persist();return this.state();}
  async move(id,direction){await this.initialized;if(this.busy) throw fail('intake-busy',409);this.item(id);if(![-1,1].includes(direction)) throw fail('invalid-direction');let i=this.items.findIndex(x=>x.id===id), j=i+direction;if(j>=0 && j<this.items.length) [this.items[i],this.items[j]]=[this.items[j],this.items[i]];await this.persist();return this.state();}
  async remove(id){await this.initialized;if(this.busy) throw fail('intake-busy',409);const d=this.item(id);if(d.status==='unknown') throw fail('draft-locked',409);this.items=this.items.filter(x=>x!==d);await this.persist();return this.state();}
  async evaluate(id){await this.initialized;if(this.busy) throw fail('intake-busy',409);const d=this.item(id);if(['unknown','submitting','submitted'].includes(d.status)) throw fail('draft-locked',409);this.busy=true;d.status='assessing';d.startedAt=new Date().toISOString();delete d.error;delete d.answers;this.abort=new AbortController();
    try{await this.persist();}catch(e){this.busy=false;throw e;}
    Promise.resolve().then(()=>this.assess(this.root,d.requirement,this.abort.signal,this.index++,m=>{d.model=m;this.onChange();})).then(result=>{d.assessment=result;d.status='review';}).catch(error=>{d.status='draft';d.error=assessmentFailure(error);}).finally(async()=>{this.abort=null;try{await this.persist();}catch{d.error='无法保存评估结果，请检查本地存储。';}this.busy=false;this.onChange();});return this.state();}
  /**
   * Re-assess with the answers already given, so filling an unknown can flip
   * conditional -> feasible instead of forcing the user to start over.
   */
  async reassess(id){
    await this.initialized;
    if(this.busy) throw fail('intake-busy',409);
    const d=this.item(id);
    if(d.status!=='review') throw fail('assessment-not-ready',409);
    if(!Array.isArray(d.answers)||!d.answers.length) throw fail('answers-required',409);
    const answers=validateAnswers(d.assessment,d.answers);
    const previousAssessment=d.assessment;
    const previousQuestions=questions(previousAssessment);
    this.busy=true;d.status='assessing';d.startedAt=new Date().toISOString();delete d.error;delete d.answersReset;this.abort=new AbortController();
    try{await this.persist();}catch(e){this.busy=false;throw e;}
    Promise.resolve()
      .then(()=>this.assess(this.root,d.requirement,this.abort.signal,this.index++,m=>{d.model=m;this.onChange();},{answers,questions:previousQuestions,confirmed:true}))
      .then(result=>{
        d.assessment=result;d.status='review';d.reassessCount=(d.reassessCount??0)+1;
        // Keep answers only when the question list still lines up; otherwise the
        // user must confirm again rather than submit stale answers.
        const next=questions(result);
        if(next.length===answers.length) d.answers=answers; else { delete d.answers; d.answersReset=true; }
        delete d.ready;
      })
      .catch(error=>{d.status='review';d.assessment=previousAssessment;d.answers=answers;d.error=assessmentFailure(error);})
      .finally(async()=>{this.abort=null;try{await this.persist();}catch{d.error='无法保存评估结果，请检查本地存储。';}this.busy=false;this.onChange();});
    return this.state();
  }
  async answer(id,answers,ready,milestone){await this.initialized;if(this.busy) throw fail('intake-busy',409);const d=this.item(id);if(d.status!=='review') throw fail('assessment-not-ready',409);if(typeof ready!=='boolean'||!(milestone===null||/^M[0-4]$/.test(milestone))) throw fail('invalid-choice');d.answers=validateAnswers(d.assessment,answers);d.ready=ready;d.milestone=milestone;await this.persist();return this.state();}
  async batch(ids){await this.initialized;if(this.busy) throw fail('intake-busy',409);if(!Array.isArray(ids)||!ids.length||ids.length>200||new Set(ids).size!==ids.length) throw fail('invalid-selection');const selected=ids.map(id=>this.item(id));for(const d of selected){if(d.status!=='review'||typeof d.ready!=='boolean') throw fail('assessment-not-ready',409);validateAnswers(d.assessment,d.answers);if(/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})/.test(JSON.stringify(d))) throw fail('potential-secret',409);}
    if(this.items.some(d=>d.status==='unknown')) throw fail('submit-unresolved',409);this.busy=true;try{try{await access(join(dataRoot(this.root),'intake','pending-submit.json'));throw fail('submit-unresolved',409);}catch(e){if(e.code!=='ENOENT') throw e;}}catch(e){this.busy=false;throw e;}this.onChange();
    Promise.resolve().then(async()=>{for(const d of this.items.filter(x=>ids.includes(x.id))){d.status='submitting';await this.persist();try{d.url=await this.submit(this.root,{...d,confirmationQuestions:questions(d.assessment)});d.status='submitted';await this.persist();}catch{d.status='unknown';d.error='提交结果不确定，请在 GitHub 核实后解除锁定；后续草稿未提交。';await this.persist();break;}}}).catch(()=>{const d=this.items.find(x=>x.status==='submitting');if(d){d.status='unknown';d.error='保存提交状态失败，请核实 GitHub 后重启控制台。';}}).finally(()=>{this.busy=false;this.onChange();});return this.state();}
  async resolve(id,created,url){await this.initialized;if(this.busy) throw fail('intake-busy',409);const d=this.item(id);if(d.status!=='unknown'||typeof created!=='boolean') throw fail('invalid-resolution');if(created){if(typeof url!=='string'||!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(url)) throw fail('invalid-url');d.status='submitted';d.url=url;}else d.status='review';delete d.error;await this.persist();return this.state();}
  shutdown(){this.abort?.abort();}
}
