import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import { login } from "../api/auth";
import { useAuthStore } from "../stores/authStore";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: (data) => {
      setAuth(data.access_token, data.user);
      navigate("/");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-[var(--color-bg)] px-6 py-8">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-[var(--shadow-lg)] border border-[var(--color-border)] p-8">
        <div className="flex flex-col items-center">
          <div
            className="w-[88px] h-[88px] rounded-[24px] bg-white flex items-center justify-center mb-5"
            style={{ boxShadow: "0 10px 25px rgba(249,115,22,0.2)" }}
          >
            <img
              src="/jangbogo.svg"
              alt="장보GO"
              className="w-16 h-16 rounded-2xl object-cover"
            />
          </div>
          <div className="text-[28px] font-extrabold text-[var(--color-text)] tracking-tight">
            장보<span className="text-[var(--color-primary)]">GO</span>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1 mb-7">
            카메라로 담고, 바로 결제하세요
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
          <input
            id="username"
            type="text"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="아이디"
            autoComplete="username"
            className="w-full h-12 px-4 bg-slate-50 border border-[var(--color-border)] rounded-xl text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)] transition-colors"
          />
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
            autoComplete="current-password"
            className="w-full h-12 px-4 bg-slate-50 border border-[var(--color-border)] rounded-xl text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)] transition-colors"
          />

          {mutation.isError && (
            <div className="text-sm text-[var(--color-danger)] bg-[var(--jb-danger-50)] border border-[var(--jb-danger-100)] rounded-xl px-4 py-2.5 mt-1">
              {(mutation.error as Error).message}
            </div>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="w-full h-12 mt-4 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-[16px] font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-[0_6px_20px_rgba(249,115,22,0.25)]"
          >
            {mutation.isPending ? "로그인 중..." : "로그인"}
          </button>
        </form>

        <div className="flex items-center justify-center gap-3.5 mt-5 text-[13px] text-[var(--color-text-secondary)]">
          <Link
            to="/signup"
            className="hover:text-[var(--color-primary)] transition-colors"
          >
            회원가입
          </Link>
          <span className="text-[var(--color-border-strong)]">·</span>
          <button
            type="button"
            onClick={() => alert("비밀번호 찾기 기능은 준비 중입니다.")}
            className="hover:text-[var(--color-primary)] transition-colors"
          >
            비밀번호 찾기
          </button>
        </div>
      </div>
    </div>
  );
}
