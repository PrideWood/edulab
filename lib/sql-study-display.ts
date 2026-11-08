export const SQL_LESSON_ORDER = [3,0,1,2] as const;
export const sqlLessonNumber=(i:number)=>i===3?1:i+2;
// Stable storage keys keep the original three rounds; presentation has four lessons.
export function classroomScheduleGroups(){return [
 {label:'课前测量',keys:['pretest','meta_pre']},
 ...SQL_LESSON_ORDER.map((i,n)=>({label:`第${n+1}课`,keys:['ai'+i,'practice'+i,'posttest'+i]})),
 {label:'课后测量',keys:['meta_post']}
];}
