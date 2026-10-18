import QRCode from 'qrcode';

/**
 * VietQR (EMV-CoIP / NAPAS) payload builder.
 *
 * Structure verified against a real production VietQR code and the PayOS
 * documentation sample:
 *   00 02 01                     payload format indicator
 *   01 02 11|12                  point of initiation (11 static, 12 dynamic/amount)
 *   38 xx                        VietQR merchant account information
 *      00 10 A000000727            NAPAS RID
 *      01 xx                       inner TLV: 00 = bank BIN, 01 = account number
 *      02 08 QRIBFTTA              NAPAS service code (interbank fund transfer)
 *   53 03 704                    currency VND
 *   54 xx <amount>               amount (dynamic only)
 *   58 02 VN                     country
 *   62 xx                        additional data
 *      08 xx <message>             transfer content (bill number)
 *   63 04 <crc>                  CRC16-CCITT (0xFFFF, poly 0x1021) over all bytes incl. "6304"
 */
export interface VietQrInput {
  bin: string;
  accountNumber: string;
  accountName: string;
  amount?: number | null;
  message?: string | null;
}

function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new Error(`TLV value too long for tag ${tag}`);
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

export function crc16ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildVietQrString(input: VietQrInput): string {
  if (!/^\d{6}$/.test(input.bin)) throw new Error('VietQR: BIN must be 6 digits');
  if (!/^\d{6,20}$/.test(input.accountNumber)) throw new Error('VietQR: account number must be 6-20 digits');
  const dynamic = input.amount !== undefined && input.amount !== null && input.amount > 0;
  const inner = tlv('00', input.bin) + tlv('01', input.accountNumber);
  let payload =
    tlv('00', '01') +
    tlv('01', dynamic ? '12' : '11') +
    tlv('38', tlv('00', 'A000000727') + tlv('01', inner) + tlv('02', 'QRIBFTTA')) +
    tlv('53', '704') +
    (dynamic ? tlv('54', String(input.amount)) : '') +
    tlv('58', 'VN');
  if (input.message) {
    // transfer content: keep ASCII-safe, uppercase, no spaces issues for bank parsers
    const msg = input.message.slice(0, 25);
    payload += tlv('62', tlv('08', msg));
  }
  payload += '6304';
  return payload + crc16ccitt(payload);
}

export interface ParsedTag {
  tag: string;
  value: string;
}

/** EMV TLV parser (top level + one nesting level for composite tags). */
export function parseEmv(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = parseInt(payload.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len)) break;
    const value = payload.slice(i + 4, i + 4 + len);
    out.set(tag, value);
    i += 4 + len;
  }
  return out;
}

export function verifyVietQrCrc(payload: string): boolean {
  const crc = payload.slice(-4);
  return crc16ccitt(payload.slice(0, -4)) === crc.toUpperCase();
}

export async function vietQrPng(payload: string, width = 640): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: 'png',
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#04594c', light: '#ffffff' },
  });
}
