export function classroomScheduleGroups(){return [
 {label:'课前测量',keys:['pretest','meta_pre']},
 ...Array.from({length:3},(_,i)=>({label:`第${i+1}课`,keys:['ai'+i,'practice'+i,'posttest'+i]})),
 {label:'课后测量',keys:['meta_post']}
];}
