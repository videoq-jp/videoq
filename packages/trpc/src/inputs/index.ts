import { qaInputSchemas } from '../qa';
import { accountInputSchemas } from "./account";
import { adminInputSchemas } from "./admin";
import { billingInputSchemas } from "./billing";
import { chatInputSchemas } from "./chat";
import { coursesInputSchemas } from "./courses";
import { tagsInputSchemas } from "./tags";
import { videosInputSchemas } from "./videos";

/** The single source of validation and parsed handler input types. */

export const inputSchemas = {
  ...qaInputSchemas,
  ...accountInputSchemas,
  ...adminInputSchemas,
  ...billingInputSchemas,
  ...chatInputSchemas,
  ...coursesInputSchemas,
  ...tagsInputSchemas,
  ...videosInputSchemas,
};
