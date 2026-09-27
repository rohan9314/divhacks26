import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isValidClassicAddress } from "xrpl";
import { registerOnboardedCustomer, type RegisteredCustomer } from "./customers.js";
import type { WalletRegistry } from "./wallets.js";
import type { UserProfileWriter } from "../../profiles/tiger.js";

export interface OnboardedAccount {
  photonSenderId: string;
  customerId: string;
  customerName: string;
  xrplAddress?: string;
  createdAt: string;
  /** DeepSpace user id when the wallet was requested from that account. */
  userId?: string;
}

export interface EnrollAccountInput {
  photonSenderId: string;
  displayName?: string;
  /** DeepSpace `userId` (JWT subject). Wallet customer ids are keyed by this when set. */
  userId?: string;
  /** When true, faucet a Testnet wallet this process can sign. Never accepts a user-supplied seed. */
  provisionWallet?: boolean;
}

export interface EnrollAccountResult {
  photonSenderId: string;
  customerId: string;
  customerName: string;
  xrplAddress?: string;
  created: boolean;
  userId?: string;
}

interface AccountsFile {
  accounts: OnboardedAccount[];
}

function normalizePhotonSender(id: string): string {
  const trimmed = id.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.replace(/[\s().-]/g, "");
}

export function customerIdForPhotonSender(photonSenderId: string): string {
  const digest = createHash("sha256").update(normalizePhotonSender(photonSenderId)).digest("hex").slice(0, 16);
  return `onboard_${digest}`;
}

export function isPlaceholderDisplayName(name: string | undefined): boolean {
  return /^User [0-9a-f]{4,}$/i.test(name?.trim() ?? "");
}

function preferredDisplayName(incoming: string | undefined, existing: string | undefined, customerId: string): string {
  const next = incoming?.trim();
  const prior = existing?.trim();
  const picked =
    (next && !isPlaceholderDisplayName(next) ? next : undefined) ||
    (prior && !isPlaceholderDisplayName(prior) ? prior : undefined) ||
    next ||
    prior ||
    `User ${customerId.slice(-6)}`;
  return picked.slice(0, 40);
}

export function customerIdForUser(userId: string): string {
  const digest = createHash("sha256").update(`user:${userId.trim()}`).digest("hex").slice(0, 16);
  return `user_${digest}`;
}

export function onboardBearerOk(expected: string | undefined, header: string | undefined): boolean {
  if (!expected) return false;
  const got = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

export class AccountOnboardingStore {
  private accounts: OnboardedAccount[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  list(): OnboardedAccount[] {
    return this.accounts.map((row) => ({ ...row }));
  }

  customerIdForPhoton(photonSenderId: string): string | undefined {
    const id = normalizePhotonSender(photonSenderId);
    return this.accounts.find((row) => row.photonSenderId === id)?.customerId;
  }

  findByPhoton(photonSenderId: string): OnboardedAccount | undefined {
    const id = normalizePhotonSender(photonSenderId);
    return this.accounts.find((row) => row.photonSenderId === id);
  }

  findByUserId(userId: string): OnboardedAccount | undefined {
    const id = userId.trim();
    if (!id) return undefined;
    return this.accounts.find((row) => row.userId === id);
  }

  findByDisplayName(name: string): RegisteredCustomer | undefined {
    const key = name.trim().toLowerCase();
    const row = this.accounts.find((account) => account.customerName.toLowerCase() === key);
    return row ? { customerId: row.customerId, customerName: row.customerName } : undefined;
  }

  findByAddress(xrplAddress: string): OnboardedAccount | undefined {
    const address = xrplAddress.trim();
    if (!isValidClassicAddress(address)) return undefined;
    return this.accounts.find((row) => row.xrplAddress === address);
  }

  findByCustomerId(customerId: string): OnboardedAccount | undefined {
    const id = customerId.trim().toLowerCase();
    if (!id) return undefined;
    return this.accounts.find((row) => row.customerId.toLowerCase() === id);
  }

  /** Public facts Gemini may use: name, userId, wallet, and iMessage handle. */
  peopleDirectory(): Array<{ displayName: string; userId?: string; xrplAddress?: string; imessage?: string }> {
    return this.accounts.map((row) => ({
      displayName: row.customerName,
      ...(row.userId && { userId: row.userId }),
      ...(row.xrplAddress && { xrplAddress: row.xrplAddress }),
      ...(row.photonSenderId && { imessage: row.photonSenderId }),
    }));
  }

  displayNames(): string[] {
    return this.accounts.map((row) => row.customerName);
  }

  senderMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.accounts) out[row.photonSenderId] = row.customerId;
    return out;
  }

  registerAll(): void {
    for (const row of this.accounts) {
      registerOnboardedCustomer({ customerId: row.customerId, customerName: row.customerName });
    }
  }

  upsert(account: OnboardedAccount): void {
    const photonSenderId = normalizePhotonSender(account.photonSenderId);
    const next = { ...account, photonSenderId };
    let index = next.userId ? this.accounts.findIndex((row) => row.userId === next.userId) : -1;
    if (index === -1) index = this.accounts.findIndex((row) => row.photonSenderId === photonSenderId);
    if (index === -1) this.accounts.push(next);
    else this.accounts[index] = { ...this.accounts[index], ...next, createdAt: this.accounts[index]!.createdAt };
    registerOnboardedCustomer({ customerId: next.customerId, customerName: next.customerName });
    this.save();
  }

  setAddress(customerId: string, xrplAddress: string): void {
    if (!isValidClassicAddress(xrplAddress)) return;
    const index = this.accounts.findIndex((row) => row.customerId === customerId);
    if (index === -1) return;
    this.accounts[index] = { ...this.accounts[index]!, xrplAddress };
    this.save();
  }

  private accountKey(row: Partial<OnboardedAccount>): string {
    return (row.userId?.trim() || row.photonSenderId?.trim() || row.customerId?.trim() || "").toLowerCase();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as AccountsFile;
      this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    } catch {
      this.accounts = [];
    }
    this.registerAll();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    let disk: OnboardedAccount[] = [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as AccountsFile;
      if (Array.isArray(parsed.accounts)) disk = parsed.accounts;
    } catch {
      disk = [];
    }
    const byKey = new Map<string, OnboardedAccount>();
    for (const row of disk) {
      const key = this.accountKey(row);
      if (key) byKey.set(key, row);
    }
    for (const row of this.accounts) {
      const key = this.accountKey(row);
      if (!key) continue;
      const prev = byKey.get(key);
      byKey.set(key, {
        ...prev,
        ...row,
        userId: row.userId || prev?.userId,
        photonSenderId: row.photonSenderId || prev?.photonSenderId || row.photonSenderId,
        customerName: preferredDisplayName(row.customerName, prev?.customerName, row.customerId),
        xrplAddress: row.xrplAddress || prev?.xrplAddress,
        createdAt: prev?.createdAt ?? row.createdAt,
      });
    }
    this.accounts = [...byKey.values()];
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: this.accounts }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class AccountOnboardingService {
  constructor(
    private readonly store: AccountOnboardingStore,
    private readonly registry?: WalletRegistry,
    private readonly profiles?: UserProfileWriter,
  ) {
    this.store.registerAll();
  }

  async enroll(input: EnrollAccountInput): Promise<EnrollAccountResult> {
    const photonSenderId = normalizePhotonSender(input.photonSenderId);
    if (!photonSenderId || photonSenderId.length < 8) {
      throw Object.assign(new Error("invalid_photon_sender"), { code: "invalid_photon_sender" });
    }
    const userId = input.userId?.trim() || undefined;
    if (userId && (userId.length < 4 || userId.length > 80)) {
      throw Object.assign(new Error("invalid_user_id"), { code: "invalid_user_id" });
    }
    const existing = (userId ? this.store.findByUserId(userId) : undefined) ?? this.store.findByPhoton(photonSenderId);
    const customerId =
      existing?.customerId ?? (userId ? customerIdForUser(userId) : customerIdForPhotonSender(photonSenderId));
    const created = !existing;
    const customerName = preferredDisplayName(input.displayName, existing?.customerName, customerId);
    this.store.upsert({
      photonSenderId,
      customerId,
      customerName,
      xrplAddress: existing?.xrplAddress,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      userId: userId ?? existing?.userId,
    });
    let xrplAddress = this.store.list().find((row) => row.customerId === customerId)?.xrplAddress;
    if (input.provisionWallet === true && this.registry) {
      const wallet = await this.registry.ensureCustomerTestnetWallet(customerId);
      xrplAddress = wallet.xrplAddress;
      this.store.setAddress(customerId, wallet.xrplAddress);
    }
    if (this.profiles) {
      try {
        await this.profiles.upsert({
          userId: userId ?? existing?.userId ?? `photon:${photonSenderId}`,
          displayName: customerName,
          photonIdentifier: photonSenderId,
          walletAddress: xrplAddress ?? "0",
        });
      } catch (error) {
        console.error(
          `Tiger profile upsert skipped: ${error instanceof Error ? error.message.slice(0, 160) : "Error"}`,
        );
      }
    }
    return { photonSenderId, customerId, customerName, xrplAddress, created, userId: userId ?? existing?.userId };
  }

  publicView(photonSenderId: string): OnboardedAccount | undefined {
    return this.store.findByPhoton(photonSenderId);
  }

  publicViewByUserId(userId: string): OnboardedAccount | undefined {
    return this.store.findByUserId(userId);
  }
}

export function onboardHttpAuth(
  expected: string | undefined,
  header: string | undefined,
): { error: string } | undefined {
  if (!expected) return { error: "deepspace_onboarding_unconfigured" };
  if (!onboardBearerOk(expected, header)) return { error: "unauthorized" };
  return undefined;
}

export const ONBOARDING_ACCOUNTS_PATH = "data/ripple-demo/accounts.json";

