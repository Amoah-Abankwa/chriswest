import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

export const notFound = (message = 'Not found') => new NotFoundException({ code: 'NOT_FOUND', message });
export const conflict = (code: string, message: string, details?: unknown) =>
  new ConflictException({ code, message, details });
export const badRequest = (code: string, message: string) => new BadRequestException({ code, message });

export const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
export const isForeignKeyViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
