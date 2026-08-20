import bcrypt from 'bcrypt';

const BCRYPT_MAX_PASSWORD_BYTES = 72;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
}

export class BcryptPasswordHasher implements PasswordHasher {
  public constructor(private readonly cost: number) {}

  public async hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.cost);
  }

  public async compare(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
  }
}

export const validatePassword = (password: string, minimumLength: number): string | null => {
  if (password.length < minimumLength) {
    return `Password must contain at least ${minimumLength} characters.`;
  }

  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    return 'Password must not exceed 72 UTF-8 bytes.';
  }

  return null;
};
