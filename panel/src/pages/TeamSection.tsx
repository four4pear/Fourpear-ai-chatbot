import { useEffect, useState } from "react";
import { api, type Membership } from "../api";
import { initials } from "./inbox-shared";

type Member = { id: string; name: string; email: string; role: "owner" | "agent"; lastLoginAt: string | null };
type Invite = { id: string; email: string; role: "owner" | "agent"; expiresAt: string };

const ROLE = { owner: "Sahip", agent: "Çalışan" };
const day = (iso: string) => new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });

/** Ekip (yalnızca sahip): üyeleri listele, davet et, şifre linki ver, ekipten çıkar. Davet ve şifre linkini sahip kendisi iletir. */
export function TeamSection({ store, userId }: { store: Membership; userId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"agent" | "owner">("agent");
  /** Az önce üretilen link (davet ya da şifre): bir kez gösterilir, kopyalanıp kişiye iletilir. */
  const [link, setLink] = useState<{ text: string; for: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/tenants/${store.tenantId}`;

  async function load() {
    try {
      const r = await api<{ members: Member[]; invites: Invite[] }>(`${base}/members`);
      setMembers(r.members ?? []); setInvites(r.invites ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Ekip yüklenemedi"); }
  }
  useEffect(() => { void load(); }, [base]);

  async function run(task: () => Promise<void>) {
    setBusy(true); setError(""); setCopied(false);
    try { await task(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "İşlem yapılamadı"); }
    finally { setBusy(false); }
  }

  const invite = () => run(async () => {
    const r = await api<{ link: string; expiresInDays: number }>(`${base}/invites`, { method: "POST", body: { email: email.trim(), role } });
    setLink({ text: r.link, for: `${email.trim()} için davet linki (${r.expiresInDays} gün geçerli, tek kullanımlık)` });
    setEmail("");
  });
  const resetLink = (m: Member) => run(async () => {
    const r = await api<{ link: string; expiresInHours: number }>(`${base}/members/${m.id}/reset-link`, { method: "POST" });
    setLink({ text: r.link, for: `${m.name} için şifre linki (${r.expiresInHours} saat geçerli, tek kullanımlık)` });
  });
  const remove = (m: Member) => {
    if (!window.confirm(`${m.name} ekipten çıkarılsın mı? Bu mağazaya erişimi hemen kapanır.`)) return;
    return run(async () => { await api(`${base}/members/${m.id}`, { method: "DELETE" }); });
  };
  const cancelInvite = (i: Invite) => run(async () => { await api(`${base}/invites/${i.id}`, { method: "DELETE" }); });

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.text); setCopied(true); }
    catch { setError("Kopyalanamadı; linki seçip elle kopyalayın."); }
  }

  return <section id="team" className="panel-card settings-card" aria-labelledby="team-title">
    <h2 id="team-title">Ekip</h2>
    {error && <p role="alert" className="test-error">{error}</p>}
    {members === null && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {members && <ul className="team-list">{members.map((m) => <li key={m.id}>
      <span className="avatar-md" aria-hidden="true">{initials(m.name)}</span>
      <span className="team-who"><strong>{m.name}</strong> <span className="hint">{m.email} · {ROLE[m.role]}{m.lastLoginAt ? ` · son giriş ${day(m.lastLoginAt)}` : " · henüz giriş yapmadı"}</span></span>
      <span className="team-actions">
        <button className="btn btn-secondary" disabled={busy} aria-label={`Şifre linki: ${m.name}`} onClick={() => void resetLink(m)}>Şifre linki</button>
        {m.id !== userId && <button className="btn btn-secondary" disabled={busy} aria-label={`Ekipten çıkar: ${m.name}`} onClick={() => void remove(m)}>Çıkar</button>}
      </span>
    </li>)}</ul>}
    {invites.length > 0 && <>
      <h3>Bekleyen davetler</h3>
      <ul className="team-list">{invites.map((i) => <li key={i.id}>
        <span className="team-who">{i.email} <span className="hint">· {ROLE[i.role ?? "agent"]} · {day(i.expiresAt)} tarihine kadar</span></span>
        <button className="btn btn-secondary" disabled={busy} aria-label={`Daveti iptal et: ${i.email}`} onClick={() => void cancelInvite(i)}>İptal et</button>
      </li>)}</ul>
    </>}
    {link && <div className="team-link" role="status">
      <p><strong>{link.for}</strong></p>
      <p className="hint">Bu linki yalnızca ilgili kişiye iletin; kapattığınızda yeniden görüntülenemez.</p>
      <input readOnly aria-label="Link" value={link.text} onFocus={(e) => e.currentTarget.select()} />
      <button className="btn btn-primary" onClick={() => void copy()}>{copied ? "Kopyalandı" : "Kopyala"}</button>
      <button className="link-button" onClick={() => setLink(null)}>Kapat</button>
    </div>}
    <h3>Yeni kişi davet et</h3>
    <form className="team-invite" onSubmit={(e) => { e.preventDefault(); if (email.trim()) void invite(); }}>
      <label className="sr-only" htmlFor="invite-email">E-posta</label>
      <input id="invite-email" type="email" required placeholder="ornek@eposta.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="sr-only" htmlFor="invite-role">Rol</label>
      <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as "agent" | "owner")}>
        <option value="agent">Çalışan (konuşmalara bakar)</option>
        <option value="owner">Sahip (her şeye erişir)</option>
      </select>
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>Davet linki oluştur</button>
    </form>
    <p className="hint">Davet e-postayla gönderilmez: oluşan linki kişiye siz iletirsiniz (WhatsApp, e-posta…).</p>
  </section>;
}
