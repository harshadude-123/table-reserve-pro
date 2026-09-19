import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useAuth } from "@/hooks/use-auth";
import { useFirebaseConfig } from "@/lib/firebase";
import logo from "@/assets/logo.svg";
import { ArrowRight, KeyRound, Loader2, Mail, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const {
    isLoading: authLoading,
    isAuthenticated,
    signIn,
    signUp,
    signInAsGuest,
  } = useAuth();
  const { configured: firebaseConfigured, loading: configLoading } =
    useFirebaseConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  function friendlyAuthError(e: unknown): string {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code: unknown }).code)
        : "";
    switch (code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Incorrect email or password.";
      case "auth/email-already-in-use":
        return "An account with this email already exists — sign in instead.";
      case "auth/weak-password":
        return "Password should be at least 6 characters.";
      case "auth/invalid-email":
        return "That email address doesn't look right.";
      case "auth/too-many-requests":
        return "Too many attempts — please wait a moment and try again.";
      case "auth/operation-not-allowed":
        return "This sign-in method is disabled in Firebase. Enable Email/Password (and Anonymous for guests) in the Firebase console.";
      case "auth/network-request-failed":
        return "Network error — check your connection and try again.";
      default:
        return e instanceof Error ? e.message : "Sign-in failed. Please try again.";
    }
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      if (mode === "signUp") {
        await signUp(email.trim(), password);
      } else {
        await signIn(email.trim(), password);
      }
      navigate(redirect);
    } catch (e) {
      setError(friendlyAuthError(e));
      setIsLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signInAsGuest();
      navigate(redirect);
    } catch (e) {
      setError(friendlyAuthError(e));
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Auth Content */}
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="flex items-center justify-center h-full flex-col">
          <Card className="min-w-[350px] pb-0 border shadow-md">
            <>
              <CardHeader className="text-center">
                <div className="flex justify-center">
                  <img
                    src={logo}
                    alt="TableKeeper"
                    width={64}
                    height={64}
                    className="rounded-lg mb-4 mt-4 cursor-pointer"
                    onClick={() => navigate("/")}
                  />
                </div>
                <CardTitle className="text-xl">
                  {mode === "signUp" ? "Create your account" : "Welcome back"}
                </CardTitle>
                <CardDescription>
                  {mode === "signUp"
                    ? "Sign up with email to start booking tables"
                    : "Sign in with email to manage your reservations"}
                </CardDescription>
              </CardHeader>
              <form onSubmit={handleSubmit}>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="email"
                        placeholder="name@example.com"
                        type="email"
                        className="pl-9"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password</Label>
                    <div className="relative">
                      <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="password"
                        placeholder={mode === "signUp" ? "At least 6 characters" : "Your password"}
                        type="password"
                        className="pl-9"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                        minLength={6}
                        disabled={isLoading}
                        required
                      />
                    </div>
                  </div>

                  {error && <p className="text-sm text-red-500">{error}</p>}

                  <Button type="submit" className="w-full" disabled={isLoading || configLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {mode === "signUp" ? "Creating account…" : "Signing in…"}
                      </>
                    ) : (
                      <>
                        {mode === "signUp" ? "Create account" : "Sign in"}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>

                  <div className="mt-1">
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-background px-2 text-muted-foreground">Or</span>
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full mt-4"
                      onClick={handleGuestLogin}
                      disabled={isLoading || configLoading}
                    >
                      <UserX className="mr-2 h-4 w-4" />
                      Continue as Guest
                    </Button>

                    <p className="mt-4 text-center text-sm text-muted-foreground">
                      {mode === "signUp" ? (
                        <>
                          Already have an account?{" "}
                          <Button
                            type="button"
                            variant="link"
                            className="p-0 h-auto"
                            onClick={() => {
                              setMode("signIn");
                              setError(null);
                            }}
                          >
                            Sign in
                          </Button>
                        </>
                      ) : (
                        <>
                          New to TableKeeper?{" "}
                          <Button
                            type="button"
                            variant="link"
                            className="p-0 h-auto"
                            onClick={() => {
                              setMode("signUp");
                              setError(null);
                            }}
                          >
                            Create an account
                          </Button>
                        </>
                      )}
                    </p>
                  </div>
                </CardContent>
              </form>
            </>

            <div className="py-4 px-6 text-xs text-center text-muted-foreground bg-muted border-t rounded-b-lg">
              Secured by Firebase Authentication
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
