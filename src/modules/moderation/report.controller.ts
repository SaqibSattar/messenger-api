import type { Request, Response } from 'express';
import { created, ok } from '../../utils/apiResponse';
import { UnauthorizedError } from '../../utils/errors';
import * as reportService from './report.service';
import type {
  CreateReportInput,
  ListReportsQuery,
  UpdateReportStatusInput
} from './report.validation';

const requireActor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

const auditContext = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return {
    actorId: req.user.id,
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.header('user-agent') ?? undefined
  };
};

export const createReportHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as CreateReportInput;
  const report = await reportService.createReport(actor, input, auditContext(req));
  created(res, { report });
};

export const listReportsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as ListReportsQuery;
  const result = await reportService.listReports(actor, query);
  ok(res, result);
};

export const getReportHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const report = await reportService.getReport(actor, req.params.reportId);
  ok(res, { report });
};

export const updateReportStatusHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const actor = requireActor(req);
  const input = req.body as UpdateReportStatusInput;
  const report = await reportService.updateReportStatus(
    actor,
    req.params.reportId,
    input,
    auditContext(req)
  );
  ok(res, { report });
};
