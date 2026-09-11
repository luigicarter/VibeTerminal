import { WaitlistForm } from "../components/WaitlistForm";
import type { WaitlistResponse } from "../types/api";

type WaitlistSectionProps = { disabled: boolean; error: string | null; result: WaitlistResponse | null; onSubmit: (email: string) => void; };

export const WaitlistSection = ({ disabled, error, result, onSubmit }: WaitlistSectionProps) => {
  const message = error ?? (result ? result.status === "already_joined" ? "You're already on the list." : "You're on the list. Thanks for following Lina." : null);
  return <section className="waitlist-section section-shell" id="waitlist">
    <div><p className="eyebrow">KEEP IN THE LOOP</p><h2>A little Lina in your inbox.</h2><p>Sign up for release news and what's coming next.</p></div>
    <WaitlistForm disabled={disabled} message={message} messageTone={error ? "error" : result ? "success" : null} onSubmit={onSubmit} />
  </section>;
};
