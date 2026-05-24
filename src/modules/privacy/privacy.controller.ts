import type { Request, Response } from 'express';
import { ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as privacyService from './privacy.service';
import type { UpdatePrivacySettingsInput } from './privacy.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const getPrivacySettingsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const settings = await privacyService.getMyPrivacySettings(actor);
  ok(res, { privacySettings: settings });
};

export const updatePrivacySettingsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdatePrivacySettingsInput;
  const settings = await privacyService.updateMyPrivacySettings(actor, input);
  ok(res, { privacySettings: settings });
};
