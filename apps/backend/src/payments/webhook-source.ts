import { BlockList, isIP } from 'node:net';

export interface WebhookSourceVerifier {
  isAllowed(address: string | undefined): boolean;
}

const normalizeAddress = (address: string): string => {
  const withoutZone = address.split('%', 1)[0] ?? address;
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice('::ffff:'.length) : withoutZone;
};

export class YooKassaWebhookSourceVerifier implements WebhookSourceVerifier {
  private readonly allowed = new BlockList();

  public constructor() {
    this.allowed.addSubnet('185.71.76.0', 27, 'ipv4');
    this.allowed.addSubnet('185.71.77.0', 27, 'ipv4');
    this.allowed.addSubnet('77.75.153.0', 25, 'ipv4');
    this.allowed.addAddress('77.75.156.11', 'ipv4');
    this.allowed.addAddress('77.75.156.35', 'ipv4');
    this.allowed.addSubnet('77.75.154.128', 25, 'ipv4');
    this.allowed.addSubnet('2a02:5180::', 32, 'ipv6');
  }

  public isAllowed(address: string | undefined): boolean {
    if (address === undefined) {
      return false;
    }

    const normalized = normalizeAddress(address.trim());
    const family = isIP(normalized);

    if (family === 4) {
      return this.allowed.check(normalized, 'ipv4');
    }

    if (family === 6) {
      return this.allowed.check(normalized, 'ipv6');
    }

    return false;
  }
}
