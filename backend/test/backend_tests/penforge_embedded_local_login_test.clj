;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.penforge-embedded-local-login-test
  (:require
   [app.config :as cf]
   [app.db :as db]
   [app.penforge.embedded.local-login :as local-login]
   [app.rpc :as-alias rpc]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

(def ^:private secret "0123456789abcdef0123456789abcdef")

(defn- with-local-mode
  [config f]
  (with-redefs [cf/flags (conj cf/flags :penforge-local)
                cf/get   (th/config-get-mock (merge {:http-server-host "127.0.0.1"}
                                                    config))]
    (f)))

(defn- login!
  [params]
  (th/command! (merge {::th/type :penforge-local-login} params)))

(t/deftest disabled-without-the-flag
  (with-redefs [cf/get (th/config-get-mock {:penforge-local-secret secret})]
    (let [out (login! {:secret secret})]
      (t/is (th/ex-of-type? (:error out) :restriction))
      (t/is (th/ex-of-code? (:error out) :feature-disabled)))))

(t/deftest refuses-when-the-server-is-not-loopback
  (with-local-mode
    {:penforge-local-secret secret
     :http-server-host "0.0.0.0"}
    (fn []
      (let [out (login! {:secret secret})]
        (t/is (th/ex-of-code? (:error out) :penforge-local-not-loopback))))))

(t/deftest refuses-a-wrong-secret
  (with-local-mode
    {:penforge-local-secret secret}
    (fn []
      (let [out (login! {:secret "not-the-secret"})]
        (t/is (th/ex-of-code? (:error out) :wrong-credentials))))))

(t/deftest refuses-when-no-secret-is-configured
  (with-local-mode
    {:penforge-local-secret ""}
    (fn []
      (let [out (login! {:secret ""})]
        (t/is (th/ex-of-code? (:error out) :wrong-credentials))))))

(t/deftest creates-the-local-profile-once
  (with-local-mode
    {:penforge-local-secret secret}
    (fn []
      (let [first-out  (login! {:secret secret :fullname "Ada" :persona "developer"})
            second-out (login! {:secret secret})
            profile    (:result first-out)]
        (t/is (nil? (:error first-out)))
        (t/is (nil? (:error second-out)))
        (t/is (= local-login/default-email (:email profile)))
        (t/is (= "Ada" (:fullname profile)))
        (t/is (= :developer (get-in profile [:props :penforge-persona])))
        (t/is (true? (:is-active profile)))
        (t/is (nil? (:password profile)) "private attrs are stripped")
        (t/is (some? (:default-team-id profile)) "the default team exists")
        (t/is (= (:id profile) (:id (:result second-out))))
        (t/is (= 1 (count (th/db-exec! ["select id from profile where email = ?"
                                        local-login/default-email]))))))))

(t/deftest sets-the-session-cookie
  (with-local-mode
    {:penforge-local-secret secret}
    (fn []
      (let [result (th/command-raw! {::th/type :penforge-local-login :secret secret})]
        (t/is (seq (::rpc/response-transform-fns (meta result)))
              "the answer carries the session transform")))))

(t/deftest uses-the-configured-email
  (with-local-mode
    {:penforge-local-secret secret
     :penforge-local-email "Me@Example.com"}
    (fn []
      (let [out (login! {:secret secret})]
        (t/is (= "me@example.com" (get-in out [:result :email])))
        (t/is (some? (db/get th/*pool* :profile {:email "me@example.com"})))))))
