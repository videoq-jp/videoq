export type CreationIdempotency = {
  action: "request_video_upload" | "create_youtube_video" | "create_course";
  key: string;
  requestHash: string;
};
