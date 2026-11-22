import type {BusinessDecisionView} from '../../src/business-decisions.ts';
export interface DecisionAttempt {action:'answer';id:string;version:string;requestId:string;text:string}
/** One mounted question owns an immutable attempt; uncertain sends cannot change its answer. */
export class DecisionSubmission {
 private attempt:DecisionAttempt|null=null;
 private busy=false;
 get pending(){return this.attempt}
 async run(d:BusinessDecisionView,text:string,request:(body:DecisionAttempt)=>Promise<unknown>){
  if(this.busy||d.status!=='pending')return;
  this.busy=true;
  try{
   if(this.attempt&&(this.attempt.id!==d.id||this.attempt.version!==d.version))throw Error('decision_context_changed');
   const answer=text.trim();
   if(!answer||answer.length>10000)throw Error('invalid_answer');
   this.attempt??=Object.freeze({action:'answer',id:d.id,version:d.version,requestId:crypto.randomUUID(),text:answer});
   await request(this.attempt);
  }finally{this.busy=false}
 }
}
