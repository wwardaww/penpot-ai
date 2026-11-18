;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-penforge-bot-test
  (:require
   [app.common.geom.point :as gpt]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.email :as eml]
   [app.penforge.bot :as bot]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.profile :as profile]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [mockery.core :refer [with-mocks]]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

(defn- with-ai-flag
  [next]
  (with-redefs [cf/flags (conj cf/flags :ai)]
    (next)))

(defn- setup
  "Creates an owner with a team, a project and a file, a viewer of the
  team and a profile that is not a member of the team."
  []
  (let [owner   (th/create-profile* 1 {:is-active true})
        viewer  (th/create-profile* 2 {:is-active true})
        other   (th/create-profile* 3 {:is-active true})
        team    (th/create-team* 1 {:profile-id (:id owner)})
        _       (th/create-team-role* {:team-id (:id team)
                                       :profile-id (:id viewer)
                                       :role :viewer})
        project (th/create-project* 1 {:profile-id (:id owner)
                                       :team-id (:id team)})
        file    (th/create-file* 1 {:profile-id (:id owner)
                                    :project-id (:id project)})]
    {:owner owner
     :viewer viewer
     :other other
     :team team
     :file file
     :page-id (get-in file [:data :pages 0])}))

(defn- thread-params
  [type profile-id {:keys [file page-id]} content]
  {::th/type type
   ::rpc/profile-id profile-id
   :file-id (:id file)
   :page-id page-id
   :position (gpt/point 10 20)
   :content content
   :frame-id uuid/zero})

;; --- Thread created by the AI

(t/deftest bot-thread-is-authored-by-the-bot
  (with-ai-flag
    (fn []
      (let [{:keys [owner file] :as env} (setup)
            out (th/command! (thread-params :create-penforge-comment-thread
                                            (:id owner) env "[Audit] Low contrast"))]
        (t/is (th/success? out))
        (let [{:keys [id owner-id owner-fullname comment-id]} (:result out)]
          (t/is (= bot/id owner-id))
          (t/is (= "Penforge" owner-fullname))

          (t/testing "the thread and its first comment belong to the bot"
            (t/is (= bot/id (:owner-id (th/db-get :comment-thread {:id id}))))
            (t/is (= bot/id (:owner-id (th/db-get :comment {:id comment-id})))))

          (t/testing "the requester sees it as an unread thread of Penforge"
            (let [out    (th/command! {::th/type :get-comment-threads
                                       ::rpc/profile-id (:id owner)
                                       :file-id (:id file)})
                  thread (first (:result out))]
              (t/is (th/success? out))
              (t/is (= "Penforge" (:owner-fullname thread)))
              (t/is (= 1 (:count-unread-comments thread)))))

          (t/testing "the bot profile is returned for the file comments"
            (let [out (th/command! {::th/type :get-profiles-for-file-comments
                                    ::rpc/profile-id (:id owner)
                                    :file-id (:id file)})
                  bot (some #(when (= bot/id (:id %)) %) (:result out))]
              (t/is (th/success? out))
              (t/is (= "Penforge" (:fullname bot))))))))))

;; --- Reply by the AI on a thread of the user

(t/deftest bot-reply-keeps-the-user-thread
  (with-ai-flag
    (fn []
      (let [{:keys [owner] :as env} (setup)
            thread (:result (th/command! (thread-params :create-comment-thread
                                                        (:id owner) env "make this button blue")))
            out    (th/command! {::th/type :create-penforge-comment
                                 ::rpc/profile-id (:id owner)
                                 :thread-id (:id thread)
                                 :content "Done: the button is blue now."})]
        (t/is (th/success? out))
        (t/is (= bot/id (get-in out [:result :owner-id])))
        (t/is (= "Penforge" (get-in out [:result :owner-fullname])))

        (let [comments (->> (th/command! {::th/type :get-comments
                                          ::rpc/profile-id (:id owner)
                                          :thread-id (:id thread)})
                            :result)]
          (t/is (= [(:id owner) bot/id] (mapv :owner-id comments)))
          (t/is (= [(:fullname owner) "Penforge"] (mapv :owner-fullname comments))))

        (t/testing "the user thread keeps its owner and gets the bot as participant"
          (let [row (th/db-get :comment-thread {:id (:id thread)})]
            (t/is (= (:id owner) (:owner-id row)))
            (t/is (= #{(:id owner) bot/id}
                     (db/decode-transit-pgobject (:participants row))))))))))

;; --- Permissions and flag

(t/deftest bot-comments-need-the-ai-flag
  (let [{:keys [owner] :as env} (setup)
        out (th/command! (thread-params :create-penforge-comment-thread
                                        (:id owner) env "hello"))]
    (t/is (th/ex-of-type? (:error out) :restriction))
    (t/is (th/ex-of-code? (:error out) :feature-disabled))
    (t/is (nil? (th/db-get :profile {:id bot/id} {::db/remove-deleted false})))))

(t/deftest bot-comments-need-edition-permission
  (with-ai-flag
    (fn []
      (let [{:keys [owner viewer other] :as env} (setup)
            thread (:result (th/command! (thread-params :create-comment-thread
                                                        (:id owner) env "hello")))]
        (doseq [profile [viewer other]]
          (let [out (th/command! (thread-params :create-penforge-comment-thread
                                                (:id profile) env "hello"))]
            (t/is (th/ex-of-type? (:error out) :not-found)))
          (let [out (th/command! {::th/type :create-penforge-comment
                                  ::rpc/profile-id (:id profile)
                                  :thread-id (:id thread)
                                  :content "hello"})]
            (t/is (th/ex-of-type? (:error out) :not-found))))))))

(t/deftest upstream-comments-keep-the-caller-as-author
  (with-ai-flag
    (fn []
      (let [{:keys [owner] :as env} (setup)
            out (th/command! (thread-params :create-comment-thread
                                            (:id owner) env "hello"))]
        (t/is (th/success? out))
        (t/is (= (:id owner) (get-in out [:result :owner-id])))))))

;; --- The bot can never log in

(t/deftest bot-cannot-log-in
  (with-ai-flag
    (fn []
      (let [{:keys [owner team] :as env} (setup)]
        (th/command! (thread-params :create-penforge-comment-thread
                                    (:id owner) env "hello"))

        (let [row (th/db-get :profile {:id bot/id})]
          (t/is (true? (:is-blocked row)))
          (t/is (true? (:is-muted row)))
          (t/is (= "!" (:password row))))

        (t/testing "no lookup by e-mail finds the bot"
          (db/run! th/*system*
                   (fn [{:keys [::db/conn]}]
                     (t/is (nil? (profile/get-profile-by-email conn bot/email)))
                     (t/is (nil? (profile/get-profile-by-email conn "penforge-bot@penforge.invalid"))))))

        (t/testing "password login fails"
          (doseq [email [bot/email "penforge-bot@penforge.invalid"]]
            (let [out (th/command! {::th/type :login-with-password
                                    :email email
                                    :password "!"})]
              (t/is (th/ex-of-code? (:error out) :wrong-credentials)))))

        (t/testing "password recovery sends nothing"
          (with-mocks [mock {:target 'app.email/send-template :return nil}]
            (let [out (th/command! {::th/type :request-profile-recovery
                                    :email bot/email})]
              (t/is (nil? (:error out)))
              (t/is (= 0 (:call-count @mock))))))

        (t/testing "the bot is not a member of the team"
          (let [out (th/command! {::th/type :get-team-members
                                  ::rpc/profile-id (:id owner)
                                  :team-id (:id team)})]
            (t/is (th/success? out))
            (t/is (not-any? #(= bot/id (:id %)) (:result out)))))))))

(t/deftest bot-profile-guards-are-restored
  (with-ai-flag
    (fn []
      (let [{:keys [owner] :as env} (setup)]
        (th/command! (thread-params :create-penforge-comment-thread
                                    (:id owner) env "first"))
        (th/db-update! :profile {:is-blocked false :is-muted false :password "x"}
                       {:id bot/id})
        (th/command! (thread-params :create-penforge-comment-thread
                                    (:id owner) env "second"))
        (let [row (th/db-get :profile {:id bot/id})]
          (t/is (true? (:is-blocked row)))
          (t/is (true? (:is-muted row)))
          (t/is (= "!" (:password row))))))))

;; --- Editors manage the bot comments

(t/deftest editors-can-delete-and-edit-bot-comments
  (with-ai-flag
    (fn []
      (let [{:keys [owner viewer] :as env} (setup)
            editor (th/create-profile* 4 {:is-active true})
            _      (th/create-team-role* {:team-id (get-in env [:team :id])
                                          :profile-id (:id editor)
                                          :role :editor})
            thread (:result (th/command! (thread-params :create-penforge-comment-thread
                                                        (:id owner) env "[Audit] Low contrast")))
            reply  (:result (th/command! {::th/type :create-penforge-comment
                                          ::rpc/profile-id (:id owner)
                                          :thread-id (:id thread)
                                          :content "More detail"}))]

        (t/testing "a viewer cannot change them"
          (let [out (th/command! {::th/type :update-comment
                                  ::rpc/profile-id (:id viewer)
                                  :id (:id reply)
                                  :content "changed"})]
            (t/is (some? (:error out))))
          (let [out (th/command! {::th/type :delete-comment-thread
                                  ::rpc/profile-id (:id viewer)
                                  :id (:id thread)})]
            (t/is (some? (:error out)))))

        (t/testing "an editor edits and deletes a bot comment"
          (let [out (th/command! {::th/type :update-comment
                                  ::rpc/profile-id (:id editor)
                                  :id (:id reply)
                                  :content "changed"})]
            (t/is (th/success? out))
            (t/is (= "changed" (:content (th/db-get :comment {:id (:id reply)})))))
          (let [out (th/command! {::th/type :delete-comment
                                  ::rpc/profile-id (:id editor)
                                  :id (:id reply)})]
            (t/is (th/success? out))
            (t/is (nil? (th/db-get :comment {:id (:id reply)})))))

        (t/testing "the owner deletes a bot thread"
          (let [out (th/command! {::th/type :delete-comment-thread
                                  ::rpc/profile-id (:id owner)
                                  :id (:id thread)})]
            (t/is (th/success? out))
            (t/is (nil? (th/db-get :comment-thread {:id (:id thread)})))))

        (t/testing "the owner rule stays for comments of people"
          (let [user-thread (:result (th/command! (thread-params :create-comment-thread
                                                                 (:id owner) env "mine")))
                out         (th/command! {::th/type :delete-comment-thread
                                          ::rpc/profile-id (:id editor)
                                          :id (:id user-thread)})]
            (t/is (th/ex-of-code? (:error out) :not-allowed))))))))

(t/deftest bot-comments-need-the-ai-flag-to-be-deleted-by-editors
  (let [{:keys [owner] :as env} (setup)
        thread (with-redefs [cf/flags (conj cf/flags :ai)]
                 (:result (th/command! (thread-params :create-penforge-comment-thread
                                                      (:id owner) env "hello"))))
        out    (th/command! {::th/type :delete-comment-thread
                             ::rpc/profile-id (:id owner)
                             :id (:id thread)})]
    (t/is (th/ex-of-code? (:error out) :not-allowed))))

;; --- Notifications

(t/deftest bot-comments-do-not-mail-the-requester
  (with-ai-flag
    (fn []
      (let [{:keys [owner team] :as env} (setup)
            watcher (th/create-profile* 5 {:is-active true
                                           :props {:notifications {:email-comments :all}}})
            _       (th/create-team-role* {:team-id (:id team)
                                           :profile-id (:id watcher)
                                           :role :editor})
            thread  (:result (th/command! (thread-params :create-comment-thread
                                                         (:id owner) env "make it blue")))
            sent    (atom [])]
        (with-redefs [eml/send-template (fn [_ params] (swap! sent conj (:to params)) nil)]
          (t/is (th/success? (th/command! {::th/type :create-penforge-comment
                                           ::rpc/profile-id (:id owner)
                                           :thread-id (:id thread)
                                           :content "Done."})))
          (t/is (th/success? (th/command! (thread-params :create-penforge-comment-thread
                                                         (:id owner) env "[Audit] x")))))
        (t/is (not-any? #{(:email owner)} @sent))
        (t/is (= 2 (count (filter #{(:email watcher)} @sent))))))))

;; --- Bot profile upkeep

(t/deftest ensure-profile-writes-nothing-once-the-bot-exists
  (with-ai-flag
    (fn []
      (let [{:keys [owner] :as env} (setup)
            xmin (fn []
                   (-> (th/db-exec-one! ["SELECT xmin::text AS xmin FROM profile WHERE id = ?" bot/id])
                       (:xmin)))]
        (th/command! (thread-params :create-penforge-comment-thread (:id owner) env "first"))
        (let [before (xmin)]
          (th/command! (thread-params :create-penforge-comment-thread (:id owner) env "second"))
          (t/is (= before (xmin))))))))
