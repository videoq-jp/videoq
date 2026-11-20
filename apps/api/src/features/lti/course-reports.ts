import {createCourseReportRepository} from '../../persistence/factory';
import {summarizeCourseReport} from '../course-reports/service';
import {asApiError} from '../../shared/errors';
import {ltiSubjectKey} from './identity';
import type {Bindings} from '../../types/bindings';
import type {CourseReportScope,ReportPeriod} from '../../persistence/contracts/course-report-repository';
export {courseReportInput} from '../../shared/course-report';
export type {CourseReportScope} from '../../persistence/contracts/course-report-repository';
export async function courseReport(env:Bindings,scope:CourseReportScope,input:ReportPeriod){
 try {return await summarizeCourseReport({repository:()=>createCourseReportRepository(env),actorKey:ltiSubjectKey},scope,input);}
 catch(error){throw asApiError(error)??error;}
}
