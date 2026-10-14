"use client";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { SessionInfo } from "../queries";
import { GeoStrip, Logo } from "./Brand";
import { Button, Spinner, TextField } from "./ui";

function safeNext(): string {
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  // Only same-origin relative paths — never an open redirect.
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export function LoginForm() {
  const [providers, setProviders] = useState<SessionInfo["providers"] | null>(null);
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const totpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<SessionInfo>("/api/auth/session")
      .then((s) => {
        if (s.authenticated) return location.replace(safeNext());
        setProviders(s.providers);
      })
      .catch(() => setProviders({ password: true, totp: false }));
  }, []);

  useEffect(() => {
    if (needTotp) totpRef.current?.focus();
  }, [needTotp]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { password, totp: needTotp ? totp : undefined } });
      location.replace(safeNext());
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { totpRequired?: boolean }) : null;
      if (body?.totpRequired) setNeedTotp(true);
      else setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.15fr_1fr]">
      {/* Brand side: the headline and the geometric composition. */}
      <div className="relative flex flex-col overflow-hidden p-6 md:p-12">
        <Logo />
        <div className="mt-10 max-w-xl lg:mt-auto">
          <h1 className="text-[44px] font-semibold leading-[0.98] tracking-[-0.04em] text-ink animate-rise md:text-[76px]">
            Organize
            <br />
            your cloud
            <br />
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex h-[0.72em] items-center" aria-hidden>
                <span className="block h-full w-[0.36em] bg-accent [clip-path:polygon(0_0,100%_50%,0_100%)]" />
                <span className="block h-full w-[0.36em] bg-accent [clip-path:ellipse(50%_50%_at_100%_50%)]" />
              </span>
              storage
            </span>
          </h1>
          <p className="mt-6 max-w-md text-[16px] leading-relaxed text-ink-2 animate-rise [animation-delay:120ms]">
            Exabyte-scale space on your own private Telegram channel — checksummed end to end, and reachable from any device on any network.
          </p>
        </div>
        <div className="mt-10 hidden lg:block">
          <GeoStrip className="h-20" />
        </div>
      </div>

      <div className="relative flex items-center justify-center overflow-hidden p-4 pb-10 lg:border-l lg:border-line lg:bg-canvas-2 lg:p-12">
        {/* A Bauhaus composition behind the card: sun, quarter circle, dots, a triangle. */}
        <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden>
          <span className="absolute -right-28 -top-28 size-[360px] rounded-full bg-accent" style={{ animation: "bob 11s ease-in-out infinite" }} />
          <span className="absolute -bottom-px -left-px size-[240px] bg-invert [clip-path:circle(100%_at_0_100%)] animate-rise [animation-delay:200ms]" />
          <span className="absolute bottom-14 right-14 grid grid-cols-4 gap-3 animate-rise [animation-delay:320ms]">
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i} className="size-2.5 rounded-full bg-ink" style={{ animation: `pulse-dot 3.6s ease-in-out ${((i % 4) + Math.floor(i / 4)) * 0.18}s infinite`, opacity: 0.8 }} />
            ))}
          </span>
          <span className="absolute left-16 top-20 size-16 bg-[#2f5da8] [clip-path:polygon(0_100%,50%_0,100%_100%)] animate-rise [animation-delay:420ms]" />
          <span className="absolute right-[18%] top-[62%] h-3 w-28 bg-[#f2b33d] animate-rise [animation-delay:500ms]" />
        </div>
        <div className="relative z-10 w-full max-w-[420px] border-[1.5px] border-line-strong bg-surface p-7 shadow-hard animate-pop-in sm:p-9">
          <div className="label text-accent">Sign in</div>
          <h2 className="mt-1.5 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">Welcome back</h2>
          <p className="mt-1.5 text-[15px] text-ink-2">Your files are waiting.</p>

          {!providers ? (
            <div className="flex justify-center py-12">
              <Spinner className="size-7" />
            </div>
          ) : (
            <div className="mt-8 space-y-5">
              {providers.password ? (
                <form onSubmit={submit} className="space-y-4">
                  {!needTotp ? (
                    <TextField
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      placeholder="Password"
                      aria-label="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  ) : (
                    <div>
                      <div className="mb-3 flex items-center gap-2 text-[14px] text-ink-2">
                        <ShieldCheck className="size-4 text-accent" /> Enter the 6-digit code from your authenticator
                      </div>
                      <TextField
                        ref={totpRef}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9 ]*"
                        maxLength={7}
                        placeholder="123 456"
                        aria-label="Authentication code"
                        className="text-center font-mono text-lg tracking-[0.3em]"
                        value={totp}
                        onChange={(e) => setTotp(e.target.value)}
                      />
                    </div>
                  )}
                  <Button type="submit" size="lg" className="w-full" disabled={busy || (!needTotp ? !password : totp.replace(/\s/g, "").length !== 6)}>
                    {busy ? <Spinner className="size-4" /> : <KeyRound className="size-4" />}
                    {needTotp ? "Verify" : "Sign in"}
                    {!busy ? <ArrowRight className="size-4" /> : null}
                  </Button>
                </form>
              ) : null}
              {!providers.password ? (
                <p className="bg-warning-soft p-3 text-[14px] text-warning">No password is set. Put AUTH_PASSWORD in .env and restart the server.</p>
              ) : null}
              {error ? <p className="bg-danger-soft px-4 py-3 text-[14px] text-danger animate-fade-in">{error}</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
