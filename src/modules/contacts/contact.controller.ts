import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as contactService from './contact.service';
import type {
  CreateContactRequestInput,
  ListContactRequestsQuery,
  ListContactsQuery
} from './contact.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const createContactRequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateContactRequestInput;
  const request = await contactService.createContactRequest(actor, input);
  created(res, { request });
};

export const listIncomingContactRequestsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListContactRequestsQuery;
  const result = await contactService.listIncomingRequests(actor, query);
  ok(res, result);
};

export const listOutgoingContactRequestsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListContactRequestsQuery;
  const result = await contactService.listOutgoingRequests(actor, query);
  ok(res, result);
};

export const acceptContactRequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const result = await contactService.acceptContactRequest(
    actor,
    req.params.requestId
  );
  ok(res, result);
};

export const declineContactRequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const request = await contactService.declineContactRequest(
    actor,
    req.params.requestId
  );
  ok(res, { request });
};

export const cancelContactRequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const request = await contactService.cancelContactRequest(
    actor,
    req.params.requestId
  );
  ok(res, { request });
};

export const listContactsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListContactsQuery;
  const result = await contactService.listMyContacts(actor, query);
  ok(res, result);
};

export const removeContactHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  await contactService.removeContact(actor, req.params.userId);
  ok(res, { success: true });
};
