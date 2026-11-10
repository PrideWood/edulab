export const SQL_SCHEME_VERSION = 'business-workorders/1';
export const SQL_PREPARATION_LESSON = 4;
export const SQL_LESSON_ORDER = [4,0,1,2,3] as const;
export const sqlLessonNumber=(i:number)=>i===SQL_PREPARATION_LESSON?0:i+1;
export const sqlLessonLabel=(i:number)=>i===SQL_PREPARATION_LESSON?'准备课P0':`正式第${i+1}课`;
export function sqlRoundLabel(r:{index:number;scheme_version?:string;analysis_phase?:string;formal_round?:number|null}){
 if(r.scheme_version===SQL_SCHEME_VERSION)return sqlLessonLabel(r.index);
 return `历史第${r.index===3?1:r.index+2}课`;
}
export function sqlRoundPhase(r:{index:number;scheme_version?:string;analysis_phase?:string;formal_round?:number|null}){
 if(r.scheme_version===SQL_SCHEME_VERSION)return r.index===SQL_PREPARATION_LESSON?'准备阶段（流程练习）':`正式第${r.index+1}轮`;
 return r.analysis_phase==='preparation'||r.index===3?'历史准备阶段':'历史正式干预';
}
export function sqlRecordOrder(study:{scheme_version?:unknown;course_order?:unknown;rounds?:Array<{index?:unknown}>}){
 if(study.scheme_version===SQL_SCHEME_VERSION)return [...SQL_LESSON_ORDER];
 if(Array.isArray(study.course_order))return study.course_order.filter((i):i is number=>Number.isInteger(i));
 return [...new Set((study.rounds??[]).map(r=>Number(r.index)))];
}
export function classroomScheduleGroups(){return [
 {label:'准备课前测量',keys:['pretest','meta_pre']},
 ...SQL_LESSON_ORDER.map(i=>({label:sqlLessonLabel(i),keys:['ai'+i,'practice'+i,'posttest'+i]})),
 {label:'四次正式实验后测量',keys:['meta_post']}
];}
