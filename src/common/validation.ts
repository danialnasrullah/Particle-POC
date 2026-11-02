import {
  BadRequestException,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';

/**
 * Route-level ValidationPipe that returns the VF `{ detail, code }` error shape
 * (plus the field messages) instead of Nest's default `{ message, error, statusCode }`.
 */
export function strictValidationPipe(
  options: { forbidNonWhitelisted?: boolean } = {},
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: options.forbidNonWhitelisted ?? true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        detail: 'Request validation failed.',
        code: 'VALIDATION_ERROR',
        errors: flatten(errors),
      }),
  });
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((m) => `${field}: ${m}`);
    return [...own, ...flatten(e.children ?? [], field)];
  });
}
