;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-penforge-test
  (:require
   [app.common.time :as ct]
   [app.config :as cf]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.profile :as profile]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

(defn- with-ai-flag
  [next]
  (with-redefs [cf/flags (conj cf/flags :ai)]
    (next)))

(defn- setup
  "Creates an owner with a team and a project, plus a second profile
  that is not a member of the team."
  []
  (let [owner   (th/create-profile* 1)
        other   (th/create-profile* 2)
        team    (th/create-team* 1 {:profile-id (:id owner)})
        project (th/create-project* 1 {:profile-id (:id owner)
                                       :team-id (:id team)})]
    {:owner owner :other other :team team :project project}))

;; --- Persona (profile props)

(t/deftest update-profile-props-accepts-penforge-persona
  (let [profile (th/create-profile* 1)
        out     (th/command! {::th/type :update-profile-props
                              ::rpc/profile-id (:id profile)
                              :props {:penforge-persona :developer}})]
    (t/is (nil? (:error out)))
    (let [saved (profile/decode-row (th/db-get :profile {:id (:id profile)}))]
      (t/is (= :developer (get-in saved [:props :penforge-persona]))))

    ;; It can be changed later
    (let [out (th/command! {::th/type :update-profile-props
                            ::rpc/profile-id (:id profile)
                            :props {:penforge-persona :designer}})]
      (t/is (nil? (:error out)))
      (let [saved (profile/decode-row (th/db-get :profile {:id (:id profile)}))]
        (t/is (= :designer (get-in saved [:props :penforge-persona])))))))

(t/deftest update-profile-props-rejects-unknown-penforge-persona
  (let [profile (th/create-profile* 1)
        out     (th/command! {::th/type :update-profile-props
                              ::rpc/profile-id (:id profile)
                              :props {:penforge-persona :manager}})]
    (t/is (th/ex-info? (:error out)))
    (t/is (th/ex-of-type? (:error out) :validation))
    (t/is (th/ex-of-code? (:error out) :params-validation))))

;; --- Platform (project settings)

(t/deftest project-settings-crud
  (with-ai-flag
    (fn []
      (let [{:keys [owner team project]} (setup)
            project-id (:id project)]

        (t/testing "a new project has no settings"
          (let [out (th/command! {::th/type :get-penforge-project-settings
                                  ::rpc/profile-id (:id owner)
                                  :project-id project-id})]
            (t/is (nil? (:error out)))
            (t/is (nil? (:result out)))))

        (t/testing "the platform is stored"
          (let [out (th/command! {::th/type :update-penforge-project-settings
                                  ::rpc/profile-id (:id owner)
                                  :project-id project-id
                                  :platform :mobile})]
            (t/is (nil? (:error out)))
            (t/is (= {:project-id project-id :platform :mobile} (:result out)))))

        (t/testing "and read back"
          (let [out (th/command! {::th/type :get-penforge-project-settings
                                  ::rpc/profile-id (:id owner)
                                  :project-id project-id})]
            (t/is (nil? (:error out)))
            (t/is (= {:project-id project-id :platform :mobile} (:result out)))))

        (t/testing "an update replaces the platform"
          (let [out (th/command! {::th/type :update-penforge-project-settings
                                  ::rpc/profile-id (:id owner)
                                  :project-id project-id
                                  :platform :web})]
            (t/is (nil? (:error out)))
            (t/is (= :web (get-in out [:result :platform])))
            (t/is (= 1 (count (th/db-query :penforge-project-settings
                                           {:project-id project-id}))))))

        (t/testing "the team listing has the project"
          (let [out (th/command! {::th/type :get-penforge-team-project-settings
                                  ::rpc/profile-id (:id owner)
                                  :team-id (:id team)})]
            (t/is (nil? (:error out)))
            (t/is (= [{:project-id project-id :platform :web}] (:result out)))))))))

(t/deftest project-settings-rejects-unknown-platform
  (with-ai-flag
    (fn []
      (let [{:keys [owner project]} (setup)
            out (th/command! {::th/type :update-penforge-project-settings
                              ::rpc/profile-id (:id owner)
                              :project-id (:id project)
                              :platform :desktop})]
        (t/is (th/ex-info? (:error out)))
        (t/is (th/ex-of-type? (:error out) :validation))
        (t/is (th/ex-of-code? (:error out) :params-validation))))))

(t/deftest project-settings-check-permissions
  (with-ai-flag
    (fn []
      (let [{:keys [owner other team project]} (setup)
            project-id (:id project)]

        (t/testing "a stranger can not write"
          (let [out (th/command! {::th/type :update-penforge-project-settings
                                  ::rpc/profile-id (:id other)
                                  :project-id project-id
                                  :platform :web})]
            (t/is (th/ex-of-type? (:error out) :not-found))
            (t/is (empty? (th/db-query :penforge-project-settings
                                       {:project-id project-id})))))

        (t/testing "a stranger can not read"
          (th/command! {::th/type :update-penforge-project-settings
                        ::rpc/profile-id (:id owner)
                        :project-id project-id
                        :platform :web})
          (let [out (th/command! {::th/type :get-penforge-project-settings
                                  ::rpc/profile-id (:id other)
                                  :project-id project-id})]
            (t/is (th/ex-of-type? (:error out) :not-found)))
          (let [out (th/command! {::th/type :get-penforge-team-project-settings
                                  ::rpc/profile-id (:id other)
                                  :team-id (:id team)})]
            (t/is (th/ex-of-type? (:error out) :not-found))))

        (t/testing "a viewer can read but not write"
          (th/create-team-role* {:team-id (:id team)
                                 :profile-id (:id other)
                                 :role :viewer})
          (let [out (th/command! {::th/type :get-penforge-project-settings
                                  ::rpc/profile-id (:id other)
                                  :project-id project-id})]
            (t/is (nil? (:error out)))
            (t/is (= :web (get-in out [:result :platform]))))
          (let [out (th/command! {::th/type :update-penforge-project-settings
                                  ::rpc/profile-id (:id other)
                                  :project-id project-id
                                  :platform :mobile})]
            (t/is (th/ex-of-type? (:error out) :not-found))))))))

(t/deftest project-settings-hide-deleted-projects
  (with-ai-flag
    (fn []
      (let [{:keys [owner team project]} (setup)]
        (th/command! {::th/type :update-penforge-project-settings
                      ::rpc/profile-id (:id owner)
                      :project-id (:id project)
                      :platform :mobile})
        (th/db-update! :project {:deleted-at (ct/now)} {:id (:id project)})
        (let [out (th/command! {::th/type :get-penforge-team-project-settings
                                ::rpc/profile-id (:id owner)
                                :team-id (:id team)})]
          (t/is (nil? (:error out)))
          (t/is (= [] (:result out))))))))

(t/deftest project-settings-need-ai-flag
  (let [{:keys [owner project]} (setup)
        out (th/command! {::th/type :get-penforge-project-settings
                          ::rpc/profile-id (:id owner)
                          :project-id (:id project)})]
    (t/is (th/ex-of-type? (:error out) :restriction))
    (t/is (th/ex-of-code? (:error out) :feature-disabled))))
