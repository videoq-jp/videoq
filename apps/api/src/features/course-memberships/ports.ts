import type { InvitationCreateRepository } from '../../persistence/contracts/invitation-create-repository';
import type { InvitationReadRepository } from '../../persistence/contracts/invitation-read-repository';
import type { InvitationWriteRepository } from '../../persistence/contracts/invitation-write-repository';

export interface CourseMembershipDependencies {
  now(): Date;
  isValidEmail(email: string): boolean;
  createRepository: InvitationCreateRepository;
  readRepository: InvitationReadRepository;
  writeRepository: InvitationWriteRepository;
  createToken(): string;
  hashToken(token: string): Promise<string>;
  batchLimit: number;
  emailDelivery: boolean;
  baseUrl: string;
}
