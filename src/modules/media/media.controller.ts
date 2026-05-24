import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as mediaService from './media.service';
import type {
  CompleteUploadInput,
  CreateUploadUrlInput
} from './media.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createUploadUrlHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateUploadUrlInput;
  const result = await mediaService.createUploadUrl(actor, input);
  created(res, result);
};

export const completeUploadHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CompleteUploadInput;
  const attachment = await mediaService.completeUpload(actor, input);
  ok(res, { attachment });
};

export const getAttachmentHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await mediaService.getAttachmentWithDownload(
    actor,
    req.params.attachmentId
  );
  ok(res, result);
};

export const deleteAttachmentHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const attachment = await mediaService.deleteAttachment(
    actor,
    req.params.attachmentId
  );
  ok(res, { attachment });
};
