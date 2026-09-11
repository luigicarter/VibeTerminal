import { Mail } from "lucide-react";
import { FormEvent, useState } from "react";

type WaitlistFormProps = {
  disabled: boolean;
  message: string | null;
  messageTone: "success" | "error" | null;
  onSubmit: (email: string) => void;
};

export const WaitlistForm = ({ disabled, message, messageTone, onSubmit }: WaitlistFormProps) => {
  const [email, setEmail] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(email);
  };

  return (
    <form className="waitlist-form" onSubmit={handleSubmit}>
      <label htmlFor="waitlist-email">Email</label>
      <div className="waitlist-form__row">
        <input
          id="waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={254}
          aria-describedby={message ? "waitlist-message" : undefined}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={disabled}
          required
        />
        <button type="submit" disabled={disabled}>
          <Mail size={18} />
          <span>{disabled ? "Joining…" : "Subscribe"}</span>
        </button>
      </div>
      <div aria-live="polite" aria-atomic="true">{message && <p id="waitlist-message" className={`form-message form-message--${messageTone}`}>{message}</p>}</div>
    </form>
  );
};
