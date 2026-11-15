import type {privacyCollections} from '../../shared/privacy';
export type PrivacyCollection={from:string;where:string;key:string;cast:'bigint'|'uuid'|'text';context:string;data:string;binary?:'checkpoint'|'write';empty?:boolean};
const contextFor=(course:string)=>`coalesce((SELECT m.context_id FROM lms_courses m WHERE m.installation_id=p.installation AND m.course_id=${course} ORDER BY m.id LIMIT 1),(SELECT t.context_id FROM teaching_connections t WHERE t.provider='moodle' AND t.installation_id=p.installation AND t.course_id=${course} ORDER BY t.context_id COLLATE BINARY LIMIT 1),'@orphan')`;
const reportContext=(alias:string)=>`CASE WHEN EXISTS(SELECT 1 FROM lms_courses rc WHERE rc.installation_id=p.installation AND rc.course_id=${alias}.course_id AND rc.context_id=${alias}.context_id) OR EXISTS(SELECT 1 FROM teaching_connections tc WHERE tc.provider='moodle' AND tc.installation_id=p.installation AND tc.course_id=${alias}.course_id AND tc.context_id=${alias}.context_id) THEN ${alias}.context_id ELSE '@orphan' END`;
const author=(course:string)=>`(SELECT json_extract(a.value,'$.author') FROM json_each(p.authors) a WHERE json_extract(a.value,'$.id')=${course})`;
type Collection=PrivacyCollection;
const conversationFrom=`eligible p JOIN chat_conversations c ON true
  JOIN lti_conversation_scopes s ON s.thread_id=c.thread_id AND s.subject_key=p.subject`;
const logFrom=`eligible p JOIN chat_logs l ON true JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id AND s.subject_key=p.subject`;
export const privacyReadDefs:Record<typeof privacyCollections[number],Collection>={
  logs:{from:logFrom,where:'true',key:'l.id',cast:'bigint',context:contextFor('l.course_id'),
    data:`json_object('question',l.question,'answer',json(l.response),'feedback',l.feedback,'retrievedContexts',json(l.retrieved_contexts),'createdAt',l.created_at,'resourceVideoIds',json(s.resource_video_ids),'registrationId',s.registration_id,'contextId',s.context_id,'questionAuthor',json(s.classroom_author))`},
  evaluations:{from:logFrom+' JOIN chat_log_evaluations e ON e.chat_log_id=l.id',where:'true',key:'e.id',cast:'bigint',context:contextFor('l.course_id'),
    data:`json_object('status',e.status,'faithfulness',e.faithfulness,'answerRelevancy',e.answer_relevancy,'contextPrecision',e.context_precision,'createdAt',e.created_at,'evaluatedAt',e.evaluated_at)`},
  conversations:{from:conversationFrom,where:'true',key:"'thread:'||c.thread_id",cast:'text',context:contextFor('c.course_id'),
    data:`json_object('conversationId',c.conversation_id,'title',c.title,'createdAt',c.created_at,'updatedAt',c.updated_at,'expiresAt',c.expires_at,'resourceVideoIds',json(s.resource_video_ids))`},
  turns:{from:conversationFrom+' JOIN chat_conversation_turns t ON t.thread_id=c.thread_id',where:'true',key:'t.id',cast:'bigint',context:contextFor('c.course_id'),
    data:`json_object('conversationId',c.conversation_id,'question',t.question,'answer',json(t.response),'createdAt',t.created_at)`},
  questions:{from:'eligible p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id',where:`q.lti_author_id=${author('c.id')}`,key:'q.id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('questionId',q.id,'title',q.title,'body',q.body,'featured',json(CASE WHEN q.featured=1 THEN 'true' ELSE 'false' END),'sourceVideoId',q.source_video_id,'createdAt',q.created_at,'updatedAt',q.updated_at)`},
  replies:{from:'eligible p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id JOIN course_question_replies r ON r.question_id=q.id',where:`r.lti_author_id=${author('c.id')}`,key:'r.id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('questionId',q.id,'replyId',r.id,'body',r.body,'createdAt',r.created_at,'updatedAt',r.updated_at)`},
  votes:{from:'eligible p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id JOIN course_question_lti_votes v ON v.question_id=q.id',where:`v.lti_author_id=${author('c.id')}`,key:'v.question_id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('questionId',q.id,'createdAt',v.created_at)`},
  moderation:{from:'eligible p JOIN video_courses c ON true JOIN course_qa_moderation m ON m.course_id=c.id',where:`m.lti_actor_id=${author('c.id')}`,key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('questionId',m.question_id,'replyId',m.reply_id,'action',m.action,'createdAt',m.created_at)`},
  material_operations:{from:'eligible p JOIN video_courses c ON true JOIN lti_material_operations m ON m.course_id=c.id',where:'m.actor_key=p.subject',key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('operationId',m.id,'action',m.action,'sourceGeneration',m.source_generation,'requestHash',m.request_hash,'beforeRevision',m.before_revision,'afterRevision',m.after_revision,'createdAt',m.created_at)`},
  tag_operations:{from:'eligible p JOIN video_courses c ON true JOIN lti_course_tag_operations m ON m.course_id=c.id',where:'m.actor_key=p.subject',key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`json_object('operationId',m.id,'action',m.action,'requestHash',m.request_hash,'createdAt',m.created_at)`},
  report_accesses:{from:'eligible p JOIN video_courses c ON true JOIN lti_report_accesses m ON m.course_id=c.id',
    where:'m.actor_key=p.subject AND m.installation_id=p.installation',key:'m.id',cast:'uuid',context:reportContext('m'),
    data:`json_object('accessId',m.id,'from',m.from_date,'to',m.to_date,'resourceCount',m.resource_count,'scopeHash',m.scope_hash,'createdAt',m.created_at)`},
  recent_history:{from:"eligible p JOIN lti_credentials h ON h.kind='lti-history'",where:`json_extract(h.payload,'$.registrationId')=p.registration AND json_extract(h.payload,'$.subjectHash')=p.subject_hash`,key:'h.id',cast:'text',
    context:`coalesce(json_extract(h.payload,'$.contextId'),${contextFor("CASE WHEN CAST(CAST(json_extract(h.payload,'$.courseId') AS INTEGER) AS TEXT)=CAST(json_extract(h.payload,'$.courseId') AS TEXT) THEN CAST(json_extract(h.payload,'$.courseId') AS INTEGER) END")})`,
    data:`json_object('turns',json(h.payload -> '$.turns'),'expiresAt',h.expires_at)`},
  checkpoints:{from:conversationFrom+' JOIN conversation_checkpoints k ON k.thread_id=c.thread_id',where:'true',key:`json_array(k.thread_id,k.namespace,k.checkpoint_id)`,cast:'text',context:contextFor('c.course_id'),data:'',binary:'checkpoint'},
  // This saver embeds channel values in checkpoint bytes; there is no separate blobs table.
  checkpoint_blobs:{from:conversationFrom,where:'false',key:"'thread:'||c.thread_id",cast:'text',context:contextFor('c.course_id'),data:"'{}'",empty:true},
  checkpoint_writes:{from:conversationFrom+' JOIN conversation_checkpoint_writes k ON k.thread_id=c.thread_id',where:'true',key:`json_array(k.thread_id,k.namespace,k.checkpoint_id,k.task_id,k.idx)`,cast:'text',context:contextFor('c.course_id'),data:'',binary:'write'},
};
export const privacyScoped=(d:PrivacyCollection)=>`(${d.where}) AND (p.contexts IS NULL OR ${d.context} IN(SELECT value FROM json_each(p.contexts)))`;
