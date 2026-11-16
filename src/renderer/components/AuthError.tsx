import { WarningIcon } from './Icons';

interface AuthErrorProps {
  error: string;
}

export default function AuthError({ error }: AuthErrorProps) {
  return (
    <div className="app auth-error">
      <div className="auth-error-icon"><WarningIcon /></div>
      <h2>Authentication Required</h2>
      <p className="error-message">{error}</p>
      <div className="auth-instructions">
        <p>Run the following command in your terminal:</p>
        <code>gh auth login</code>
        <p className="hint">Then restart Aura.</p>
      </div>
    </div>
  );
}
