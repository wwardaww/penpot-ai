;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.penforge.embedded.local-login
  "Automatic login of the single local profile, for the single-user
  desktop mode (Penforge desktop app).

  Enabled only with the `:penforge-local` flag and a non blank
  `PENPOT_PENFORGE_LOCAL_SECRET`. The desktop shell generates that
  secret once per install, keeps it out of the browser and calls
  `penforge-local-login` itself. The command refuses to answer unless
  the backend listens on a loopback address. The first call creates the local profile (active, no
  password, with its default team); every call answers it and sets the
  session cookie, like `login-with-password` does."
  (:require
   [app.common.exceptions :as ex]
   [app.common.schema :as sm]
   [app.config :as cf]
   [app.db :as db]
   [app.http.session :as session]
   [app.loggers.audit :as audit]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.auth :as auth]
   [app.rpc.commands.profile :as profile]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.util.services :as sv]
   [cuerdas.core :as str])
  (:import
   java.nio.charset.StandardCharsets
   java.security.MessageDigest))

(def default-email
  "Email of the local profile when `PENPOT_PENFORGE_LOCAL_EMAIL` is unset."
  "you@penforge.local")

(def default-fullname
  "Name of the local profile when the shell does not send one."
  "Penforge")

(defn enabled?
  []
  (contains? cf/flags :penforge-local))

(defn local-email
  []
  (let [email (cf/get :penforge-local-email)]
    (if (str/blank? email) default-email (str/lower email))))

(def ^:private loopback-hosts
  #{"127.0.0.1" "localhost" "::1" "[::1]"})

(defn loopback-bound?
  "True when the HTTP server listens on a loopback address only
  (`PENPOT_HTTP_SERVER_HOST`). The local login never answers on a
  server other machines can reach."
  []
  (contains? loopback-hosts (some-> (cf/get :http-server-host) str/lower)))

(defn- secret-matches?
  "Constant time comparison of `candidate` with the configured secret.
  False when no secret is configured."
  [candidate]
  (let [expected (cf/get :penforge-local-secret)]
    (and (string? expected)
         (not (str/blank? expected))
         (string? candidate)
         (MessageDigest/isEqual (.getBytes ^String expected StandardCharsets/UTF_8)
                                (.getBytes ^String candidate StandardCharsets/UTF_8)))))

(defn get-or-create-local-profile
  "Answer the local profile, creating it with its default team on the
  first call. Needs a cfg with an open connection (`::db/conn`)."
  [{:keys [::db/conn] :as cfg} {:keys [fullname]}]
  (let [email (local-email)]
    (or (profile/get-profile-by-email conn email)
        (->> (auth/create-profile cfg {:email email
                                       :fullname (if (str/blank? fullname)
                                                   default-fullname
                                                   fullname)
                                       :is-active true})
             (auth/create-profile-rels cfg)))))

(def ^:private schema:penforge-local-login
  [:map {:title "penforge-local-login"}
   [:secret [:string {:max 512}]]
   [:fullname {:optional true} [:string {:max 250}]]])

(sv/defmethod ::penforge-local-login
  "Log in the single local profile of the desktop app. Answers the
  profile and sets the session cookie."
  {::rpc/auth false
   ::doc/added "2.20"
   ::climit/id :auth/global
   ::sm/params schema:penforge-local-login}
  [cfg {:keys [secret] :as params}]
  (when-not (enabled?)
    (ex/raise :type :restriction
              :code :feature-disabled
              :hint "penforge local login is disabled"))

  (when-not (loopback-bound?)
    (ex/raise :type :restriction
              :code :penforge-local-not-loopback
              :hint "penforge local login needs PENPOT_HTTP_SERVER_HOST=127.0.0.1"))

  (when-not (secret-matches? secret)
    (ex/raise :type :validation
              :code :wrong-credentials))

  (db/tx-run! cfg
              (fn [cfg]
                (let [profile (-> (get-or-create-local-profile cfg params)
                                  (profile/strip-private-attrs))]
                  (when (:is-blocked profile)
                    (ex/raise :type :restriction
                              :code :profile-blocked
                              :hint "profile is marked as blocked"))
                  (-> profile
                      (rph/with-transform (session/create-fn cfg profile))
                      (rph/with-meta {::audit/props (audit/profile->props profile)
                                      ::audit/profile-id (:id profile)}))))))
