import { useEffect, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useAppStore } from "@/store/useAppStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { User, Pencil, Save, X, Wallet, Globe, MessageCircle, Send } from "lucide-react";
import { SiX, SiDiscord } from "react-icons/si";

export function Profile() {
  const params = useParams<{ address?: string }>();
  const [, setLocation] = useLocation();
  const { wallet, profiles, updateProfile } = useAppStore();
  const { toast } = useToast();

  const address = params.address || wallet.address || "";
  const isOwnProfile = !!wallet.connected && address === wallet.address;
  const profile = profiles[address];

  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile?.displayName || "");
  const [bio, setBio] = useState(profile?.bio || "");
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatarUrl || "");
  const [twitter, setTwitter] = useState(profile?.socials.twitter || "");
  const [discord, setDiscord] = useState(profile?.socials.discord || "");
  const [telegram, setTelegram] = useState(profile?.socials.telegram || "");
  const [website, setWebsite] = useState(profile?.socials.website || "");

  useEffect(() => {
    setDisplayName(profile?.displayName || "");
    setBio(profile?.bio || "");
    setAvatarUrl(profile?.avatarUrl || "");
    setTwitter(profile?.socials.twitter || "");
    setDiscord(profile?.socials.discord || "");
    setTelegram(profile?.socials.telegram || "");
    setWebsite(profile?.socials.website || "");
    setIsEditing(false);
  }, [address, profile]);

  if (!wallet.connected && !params.address) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <User className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-display font-bold">Connect Wallet</h1>
          <p className="text-muted-foreground">
            Connect a wallet to view or edit your SSR.FUN profile.
          </p>
          <div className="p-4 bg-muted/50 rounded-lg border border-border">
            <p className="text-sm font-medium">Use the "Connect Wallet" button in the navigation bar to proceed.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!address) {
    return null;
  }

  const handleSave = () => {
    const res = updateProfile(address, {
      displayName: displayName || `${address.slice(0, 4)}...${address.slice(-4)}`,
      bio,
      avatarUrl: avatarUrl.trim() || undefined,
      socials: {
        twitter: twitter.trim() || undefined,
        discord: discord.trim() || undefined,
        telegram: telegram.trim() || undefined,
        website: website.trim() || undefined,
      },
    });
    if (res.success) {
      toast({ title: "Profile saved", description: "Your profile has been updated." });
      setIsEditing(false);
    } else {
      toast({ title: "Could not save profile", description: res.message, variant: "destructive" });
    }
  };

  const handleCancel = () => {
    setDisplayName(profile?.displayName || "");
    setBio(profile?.bio || "");
    setAvatarUrl(profile?.avatarUrl || "");
    setTwitter(profile?.socials.twitter || "");
    setDiscord(profile?.socials.discord || "");
    setTelegram(profile?.socials.telegram || "");
    setWebsite(profile?.socials.website || "");
    setIsEditing(false);
  };

  const shownName = profile?.displayName || `${address.slice(0, 4)}...${address.slice(-4)}`;
  const initials = (profile?.displayName || address).slice(0, 2).toUpperCase();
  const hasSocials = profile && Object.values(profile.socials).some(Boolean);

  return (
    <div className="container mx-auto px-4 py-10 max-w-3xl">
      <Card className="border-border">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16 border border-border">
              <AvatarImage src={isEditing ? avatarUrl : profile?.avatarUrl} alt={shownName} />
              <AvatarFallback className="bg-primary/10 text-primary font-display">{initials}</AvatarFallback>
            </Avatar>
            <div>
              <CardTitle className="font-display text-2xl">{isEditing ? (displayName || "Unnamed") : shownName}</CardTitle>
              <CardDescription className="flex items-center gap-1.5 font-mono text-xs mt-1">
                <Wallet className="h-3.5 w-3.5" /> {address.slice(0, 8)}...{address.slice(-8)}
              </CardDescription>
            </div>
          </div>
          {isOwnProfile && !isEditing && (
            <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => setIsEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit Profile
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {isEditing ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Anonymous Manager" maxLength={40} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="avatarUrl">Avatar Image URL</Label>
                <Input id="avatarUrl" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Tell other traders about yourself and the DTRs you manage." maxLength={280} rows={4} />
                <p className="text-xs text-muted-foreground text-right">{bio.length}/280</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="twitter" className="flex items-center gap-1.5"><SiX className="h-3.5 w-3.5" /> X (Twitter)</Label>
                  <Input id="twitter" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="discord" className="flex items-center gap-1.5"><SiDiscord className="h-3.5 w-3.5" /> Discord</Label>
                  <Input id="discord" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="username" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="telegram" className="flex items-center gap-1.5"><Send className="h-3.5 w-3.5" /> Telegram</Label>
                  <Input id="telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@handle" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="website" className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Website</Label>
                  <Input id="website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-2">Bio</h3>
                <p className="text-foreground whitespace-pre-wrap">
                  {profile?.bio || (isOwnProfile ? "You haven't added a bio yet." : "This user hasn't added a bio yet.")}
                </p>
              </div>

              {hasSocials && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">Socials</h3>
                  <div className="flex flex-wrap gap-2">
                    {profile?.socials.twitter && (
                      <Badge variant="outline" className="gap-1.5 py-1.5 px-3"><SiX className="h-3 w-3" /> {profile.socials.twitter}</Badge>
                    )}
                    {profile?.socials.discord && (
                      <Badge variant="outline" className="gap-1.5 py-1.5 px-3"><SiDiscord className="h-3 w-3" /> {profile.socials.discord}</Badge>
                    )}
                    {profile?.socials.telegram && (
                      <Badge variant="outline" className="gap-1.5 py-1.5 px-3"><Send className="h-3 w-3" /> {profile.socials.telegram}</Badge>
                    )}
                    {profile?.socials.website && (
                      <Badge variant="outline" className="gap-1.5 py-1.5 px-3"><Globe className="h-3 w-3" /> {profile.socials.website}</Badge>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>

        {isEditing && (
          <CardFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleCancel} className="gap-2">
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button onClick={handleSave} className="gap-2">
              <Save className="h-4 w-4" /> Save Profile
            </Button>
          </CardFooter>
        )}
      </Card>

      {!isOwnProfile && (
        <p className="text-xs text-muted-foreground text-center mt-4">
          Viewing a read-only profile. <Link href="/portfolio" className="text-primary hover:underline">Go to your portfolio</Link>.
        </p>
      )}
    </div>
  );
}
