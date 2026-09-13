import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Brand } from '../account/ui';

export function AdminMfaSetup({
  recovery,
  setupKey,
  codes,
  onContinue,
}: {
  recovery: boolean;
  setupKey: string;
  codes: string[];
  onContinue(): void;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <main className="la-admin-gate">
      <Brand subtitle="Administration" />
      <section className="la-auth-card">
        <div className="la-auth-symbol">
          {recovery ? <KeyRound size={24} /> : <ShieldCheck size={24} />}
        </div>
        <h1>
          {recovery
            ? 'Keep your recovery codes safe'
            : 'Secure your administrator account'}
        </h1>
        <p className="la-lede">
          {recovery
            ? 'Use a recovery code if you lose access to your authenticator. Each code can be used once.'
            : 'Add Lina Terminal to your authenticator app with this setup key, then enter its six-digit code.'}
        </p>
        {recovery ? (
          <>
            <ul className="la-recovery-codes" aria-label="Recovery codes">
              {codes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <label className="la-toggle">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <span>I have saved my recovery codes somewhere safe.</span>
            </label>
            <button
              className="la-button la-button--primary la-full"
              disabled={!saved}
              onClick={onContinue}
            >
              Continue to administration
            </button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onContinue();
            }}
          >
            <label className="la-field">
              Setup key
              <input
                className="la-mfa-key"
                value={setupKey}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="la-field">
              Authentication code
              <input
                className="la-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                placeholder="000000"
              />
            </label>
            <button className="la-button la-button--primary la-full">
              Verify authenticator
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
