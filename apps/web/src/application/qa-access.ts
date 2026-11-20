/** Older responses omit canVote; retain their posting-based vote capability. */
export function qaCapabilities(access: {
  canPost?: boolean; canVote?: boolean; canModerate?: boolean;
} | undefined) {
  return {
    canPost: access?.canPost,
    canVote: access?.canVote ?? access?.canPost,
    canModerate: access?.canModerate,
  };
}
