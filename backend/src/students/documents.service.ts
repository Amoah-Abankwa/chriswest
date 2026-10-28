import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { badRequest, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorage } from '../storage/file-storage';
import { detectFileType } from '../storage/file-type';
import type { UploadDocumentInput } from './students.schemas';

type Upload = { buffer: Buffer; originalname: string; mimetype: string; size: number };

const SELECT = {
  id: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  note: true,
  createdAt: true,
} as const;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string, studentId: string) {
    await this.assertStudent(schoolId, studentId);
    const docs = await this.prisma.studentDocument.findMany({
      where: { schoolId, studentId },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return { data: docs };
  }

  async upload(schoolId: string, studentId: string, file: Upload | undefined, input: UploadDocumentInput, actor: Actor) {
    await this.assertStudent(schoolId, studentId);
    if (!file || file.size === 0) throw badRequest('FILE_REQUIRED', 'Choose a file to upload.');
    const type = detectFileType(file.buffer);
    if (!type) throw badRequest('UNSUPPORTED_FILE', 'Upload a PDF, JPEG, PNG or WebP file.');

    const id = randomUUID();
    const storageKey = `schools/${schoolId}/students/${studentId}/${id}`;
    await this.storage.put(storageKey, file.buffer, type.mime);
    try {
      const doc = await this.prisma.studentDocument.create({
        data: {
          id,
          schoolId,
          studentId,
          kind: input.kind,
          originalName: file.originalname.slice(0, 200) || `document.${type.ext}`,
          contentType: type.mime,
          sizeBytes: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          storageKey,
          note: input.note ?? null,
          uploadedByUserId: actor.userId,
        },
        select: SELECT,
      });
      await this.log('document.upload', schoolId, studentId, actor, { documentId: id, kind: input.kind });
      return { data: doc };
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  async download(schoolId: string, studentId: string, documentId: string, actor: Actor) {
    const doc = await this.prisma.studentDocument.findFirst({
      where: { schoolId, studentId, id: documentId },
      select: { storageKey: true, contentType: true, originalName: true, kind: true },
    });
    if (!doc) throw notFound('Document not found');
    const body = await this.storage.get(doc.storageKey);
    await this.log('document.download', schoolId, studentId, actor, { documentId, kind: doc.kind });
    return { body, contentType: doc.contentType, originalName: doc.originalName };
  }

  async remove(schoolId: string, studentId: string, documentId: string, actor: Actor) {
    const doc = await this.prisma.studentDocument.findFirst({
      where: { schoolId, studentId, id: documentId },
      select: { id: true, storageKey: true, kind: true },
    });
    if (!doc) throw notFound('Document not found');
    await this.prisma.studentDocument.delete({ where: { id: doc.id } });
    await this.storage.delete(doc.storageKey).catch((err) =>
      this.logger.error({ msg: 'Stored file could not be deleted; remove it manually', storageKey: doc.storageKey, err }),
    );
    await this.log('document.delete', schoolId, studentId, actor, { documentId, kind: doc.kind });
  }

  private async assertStudent(schoolId: string, studentId: string) {
    const s = await this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true } });
    if (!s) throw notFound('Student not found');
  }

  private log(action: string, schoolId: string, studentId: string, actor: Actor, summary: Record<string, string>) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'student',
      resourceId: studentId,
      schoolId,
      actorUserId: actor.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}
