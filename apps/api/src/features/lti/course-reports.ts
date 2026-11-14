import {createCourseReportRepository} from '../../persistence/factory';
import {checkCourseReport} from '../../shared/course-report';
import {ltiSubjectKey} from './identity';
import type {Bindings} from '../../types/bindings';
import type {CourseReportScope,ReportPeriod} from '../../persistence/contracts/course-report-repository';
export {courseReportInput} from '../../shared/course-report';
export type {CourseReportScope} from '../../persistence/contracts/course-report-repository';
export async function courseReport(env:Bindings,scope:CourseReportScope,input:ReportPeriod){
 checkCourseReport(scope,input);
 const days=await (await createCourseReportRepository(env)).summarize(scope,input,await ltiSubjectKey(scope.sessionProof));
 const totals=days.reduce((sum,row)=>({questions:sum.questions+row.questions,good:sum.good+row.good,bad:sum.bad+row.bad,none:sum.none+row.none}),{questions:0,good:0,bad:0,none:0});
 return {period:{from:input.from,to:input.to,timezone:'UTC' as const},totals,days,coverage:'verified-moodle-resource-scope' as const};
}
