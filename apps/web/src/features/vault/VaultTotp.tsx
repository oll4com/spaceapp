import { useEffect, useMemo, useState } from "react";
import { parseVaultOtp, vaultTotp, type VaultItemRecord } from "@space/contracts";
import { api } from "../../api.js";
import { decryptVaultItem, type UnlockedVault } from "./vault-client.js";

/** The otpauth:// link a QR image holds (Google Authenticator's setup QR), read only in this tab; null when it holds none. */
export async function readVaultOtpQr(image: Blob): Promise<string | null> {
  // jsqr is CommonJS: NodeNext types its default as the module, whose own `default` is jsQR at runtime too.
  const { default: { default: jsQR } } = await import("jsqr");
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const text = jsQR(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height)?.data ?? "";
    return /^otpauth:\/\/totp\//i.test(text) ? text : null;
  } finally { bitmap.close(); }
}

/** The live code of an authenticator key: a new one each period, a ring for the seconds left, a click copies it. */
export function VaultTotpCode({ value, label }: { value: string; label: string }) {
  const otp = useMemo(() => parseVaultOtp(value), [value]);
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const step = otp ? Math.floor(now / 1000 / otp.periodSeconds) : 0;
  useEffect(() => {
    if (!otp) return;
    let live = true;
    void vaultTotp(otp.secret, new Date(step * otp.periodSeconds * 1000), otp).then((next) => { if (live) { setCode(next); setCopied(false); } });
    return () => { live = false; };
  }, [otp, step]);
  if (!otp || !code) return null;
  const left = otp.periodSeconds - (Math.floor(now / 1000) % otp.periodSeconds);
  const ring = 2 * Math.PI * 8;
  const half = Math.ceil(code.length / 2);
  return (
    <button type="button" className="vault-totp" data-ending={left <= 5 || undefined} aria-label={`Copy the code for ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>
      <span className="vault-totp-code" data-sensitive-masked="manual">{`${code.slice(0, half)} ${code.slice(half)}`}</span>
      <svg className="vault-totp-ring" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" />
        <circle cx="10" cy="10" r="8" strokeDasharray={ring} strokeDashoffset={ring * (1 - left / otp.periodSeconds)} />
      </svg>
      <span className="vault-totp-left">{copied ? "Copied" : `${left}s`}</span>
    </button>
  );
}

/** A row's live code: only the item's OTP field is opened, in this tab, while the row is shown. */
export function VaultItemTotp({ id, label, keys }: { id: string; label: string; keys: { current: UnlockedVault | null } }) {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.vaultItem(id).then(({ item }: { item: VaultItemRecord }) => item.fields.OTP && keys.current ? decryptVaultItem(keys.current, item, { OTP: item.fields.OTP }) : {} as { OTP?: string })
      .then((secrets) => { if (live) setValue(secrets.OTP ?? null); }, () => undefined);
    return () => { live = false; };
  }, [id, keys]);
  return value ? <VaultTotpCode value={value} label={label} /> : null;
}
