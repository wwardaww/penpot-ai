;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.penforge.bot
  "The Penforge bot profile: the author of the comments the Penforge AI
  writes. One per instance, created on first use.

  The bot is a profile row and nothing else: it belongs to no team, has
  no session and can never log in. Every login path is closed:

  - it is blocked (password, OIDC and LDAP login, registration retries
    and joining a team refuse blocked profiles);
  - its password is `!` (\"account without password\");
  - it is muted (no recovery e-mail, invitations refuse muted profiles);
  - its e-mail has upper case letters, while every lookup by e-mail
    lower cases its input first (`profile/clean-email`), so no login,
    recovery, registration or invitation can find it by e-mail."
  (:require
   [app.db :as db]))

(def id
  "Fixed id of the bot profile. The frontend keeps the same value in
  `app.main.data.comments/penforge-bot-id` to show the bot avatar."
  #uuid "00000000-0000-4000-8000-00000000b07a")

(def fullname "Penforge")

(def email
  "Never matched by a lookup (upper case) and never deliverable (the
  `.invalid` top level domain is reserved, RFC 2606)."
  "Penforge-Bot@penforge.invalid")

(def ^:private sql:upsert-bot
  "INSERT INTO profile (id, fullname, email, password, auth_backend,
                        is_active, is_blocked, is_muted, is_demo)
   VALUES (?, ?, ?, '!', 'penforge-bot', true, true, true, false)
   ON CONFLICT (id) DO UPDATE
      SET password = '!',
          is_blocked = true,
          is_muted = true,
          is_demo = false,
          deleted_at = NULL")

(defn ensure-profile!
  "Creates the bot profile when it is missing and puts back the fields
  that keep it from logging in. Returns the bot profile id."
  [cfg]
  (db/exec-one! cfg [sql:upsert-bot id fullname email])
  id)

(defn bot?
  "True when `profile-id` is the bot profile."
  [profile-id]
  (= id profile-id))
