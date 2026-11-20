import type { CourseReportScope, ReportPeriod, ReportDay } from '../../application/course-report';
export type { CourseReportScope, ReportPeriod, ReportDay } from '../../application/course-report';
export interface CourseReportRepository{summarize(scope:CourseReportScope,input:ReportPeriod,actorKey:string):Promise<ReportDay[]>;}
