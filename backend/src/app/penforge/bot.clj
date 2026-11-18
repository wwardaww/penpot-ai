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

(def ^:private sql:bot-ready
  "One row when the bot profile exists with every guard in place."
  "SELECT 1 AS ready
     FROM profile
    WHERE id = ?
      AND is_blocked
      AND is_muted
      AND password = '!'
      AND NOT is_demo
      AND deleted_at IS NULL")

(def ^:private sql:upsert-bot
  "INSERT INTO profile (id, fullname, email, password, auth_backend,
                        is_active, is_blocked, is_muted, is_demo)
   VALUES (?, ?, ?, '!', 'penforge-bot', true, true, true, false)
   ON CONFLICT (id) DO UPDATE
      SET password = '!',
          is_blocked = true,
          is_muted = true,
          is_demo = false,
          deleted_at = NULL
    WHERE NOT (profile.is_blocked
               AND profile.is_muted
               AND profile.password = '!'
               AND NOT profile.is_demo
               AND profile.deleted_at IS NULL)")

(defn- ready?
  [cfg]
  (some? (db/exec-one! cfg [sql:bot-ready id])))

(defn ensure-profile!
  "Creates the bot profile when it is missing and puts back the fields
  that keep it from logging in. Writes nothing when the row is already
  right. Call it outside any transaction: two first uses at once can
  race on the e-mail unique index, and the loser only checks the row the
  winner wrote. Returns the bot profile id."
  [cfg]
  (assert (nil? (::db/conn cfg)) "call it outside a transaction")
  (when-not (ready? cfg)
    (try
      (db/exec-one! cfg [sql:upsert-bot id fullname email])
      (catch org.postgresql.util.PSQLException cause
        (when-not (and (db/duplicate-key-error? cause)
                       (ready? cfg))
          (throw cause)))))
  id)

(defn bot?
  "True when `profile-id` is the bot profile."
  [profile-id]
  (= id profile-id))
