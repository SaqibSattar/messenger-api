import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as deviceService from './device.service';
import type {
  ListDevicesQuery,
  RegisterDeviceInput,
  UpdateDeviceInput
} from './device.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

export const registerDeviceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as RegisterDeviceInput;
  const device = await deviceService.registerDevice(actor, input);
  created(res, { device });
};

export const listDevicesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListDevicesQuery;
  const result = await deviceService.listMyDevices(actor, query);
  ok(res, result);
};

export const updateDeviceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateDeviceInput;
  const device = await deviceService.updateDevice(
    actor,
    req.params.deviceId,
    input
  );
  ok(res, { device });
};

export const unregisterDeviceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const device = await deviceService.unregisterDevice(
    actor,
    req.params.deviceId
  );
  ok(res, { device });
};
