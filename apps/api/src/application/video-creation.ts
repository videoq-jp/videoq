type VideoMetadata = { userId: string; title: string; description: string };

export function pendingUploadedVideo(input: VideoMetadata & { fileKey: string; transcriptionLanguage?: string }) {
  return {
    userId: input.userId, file: input.fileKey, title: input.title, description: input.description,
    transcriptionLanguage: input.transcriptionLanguage, status: 'uploading' as const, sourceType: 'uploaded' as const,
    sourceUrl: '', youtubeVideoId: '', transcript: '', errorMessage: '',
  };
}

export function pendingYoutubeVideo(input: VideoMetadata & { sourceUrl: string; youtubeVideoId: string }) {
  return {
    userId: input.userId, file: '', title: input.title, description: input.description,
    status: 'pending' as const, sourceType: 'youtube' as const, sourceUrl: input.sourceUrl,
    youtubeVideoId: input.youtubeVideoId, transcript: '', errorMessage: '',
  };
}

export function uploadConfirmationTransition() {
  return { from: 'uploading', changes: { status: 'pending', errorMessage: '' } } as const;
}

/** Uploaded reservations must still point to a live owned object. YouTube
 * creation retains its original receipt identity even after the video is gone. */
export function videoCreationReplayAllowed(kind: 'uploaded' | 'youtube', hashMatches: boolean, resourceExists: boolean): boolean {
  return hashMatches && (kind === 'youtube' || resourceExists);
}
