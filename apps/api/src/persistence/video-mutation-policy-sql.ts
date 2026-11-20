import type { UploadRefundLogic } from '../application/video-mutation';

/** All expressions come from the adapters; request values remain parameters. */
export const videoMutationStringLogic: UploadRefundLogic<string, string> = {
  statusIs: (status, expected) => `${status}='${expected}'`,
  positive: bytes => `${bytes}>0`,
  and: (left, right) => `${left} AND ${right}`,
};
