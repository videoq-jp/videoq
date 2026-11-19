/** Compatibility entrypoints; runtime composition lives in integrations. */
export { issueTeachingTicket, readTeachingTicket, connectTeachingCourse, teachingConnection } from '../../integrations/teaching';
export { ticketSchema, type TeachingTicket } from '../../shared/teaching';
