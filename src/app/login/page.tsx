import type { Metadata } from "next";
import { LoginForm } from "@/client/components/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return <LoginForm />;
}
