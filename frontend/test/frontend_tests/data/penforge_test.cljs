;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.penforge-test
  (:require
   [app.common.files.changes :as cpc]
   [app.common.schema :as sm]
   [app.common.types.file :as ctf]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.penforge :as pf]
   [app.main.ui.dashboard.penforge.create-project :as create-project]
   [app.main.ui.dashboard.penforge.option-cards :as option-cards]
   [app.main.ui.dashboard.penforge.persona :as persona]
   [cljs.test :as t :include-macros true]))

(def ^:private profile-id (uuid/next))

(defn- with-flags
  [flags f]
  (with-redefs [cf/flags flags]
    (f)))

;; --- Persona

(t/deftest role-maps-to-persona
  (t/is (= :developer (pf/role->persona "developer")))
  (t/is (= :designer (pf/role->persona "ux")))
  (t/is (= :designer (pf/role->persona "designer")))
  (t/is (nil? (pf/role->persona "marketing")))
  (t/is (nil? (pf/role->persona "other")))
  (t/is (nil? (pf/role->persona nil))))

(t/deftest get-persona-reads-profile-props
  (t/is (= :developer (pf/get-persona {:props {:penforge-persona :developer}})))
  (t/is (= :designer (pf/get-persona {:props {:penforge-persona "designer"}})))
  (t/is (nil? (pf/get-persona {:props {:penforge-persona :manager}})))
  (t/is (nil? (pf/get-persona {:props {}}))))

(t/deftest current-persona-defaults-to-designer
  (t/is (= :designer (pf/current-persona {:profile {:props {}}})))
  (t/is (= :developer (pf/current-persona
                       {:profile {:props {:penforge-persona :developer}}}))))

(t/deftest persona-pending-needs-ai-flag
  (let [profile {:id profile-id :props {}}]
    (with-flags #{:ai}
      #(t/is (true? (pf/persona-pending? profile))))
    (with-flags #{}
      #(t/is (false? (pf/persona-pending? profile))))
    (with-flags #{:ai}
      #(t/is (false? (pf/persona-pending?
                      (assoc-in profile [:props :penforge-persona] :designer)))))
    (with-flags #{:ai}
      #(t/is (false? (pf/persona-pending? {:id uuid/zero :props {}}))))))

(t/deftest persona-modal-waits-for-onboarding
  (let [profile {:id profile-id :props {}}]
    (with-flags #{:ai :onboarding}
      (fn []
        (t/is (false? (persona/show-persona-modal? profile false)))
        (t/is (true? (persona/show-persona-modal?
                      (assoc-in profile [:props :onboarding-viewed] true)
                      false)))
        (t/is (false? (persona/show-persona-modal?
                       (assoc-in profile [:props :onboarding-viewed] true)
                       true)))))
    (with-flags #{:ai}
      #(t/is (true? (persona/show-persona-modal? profile false))))))

;; --- Platform

(t/deftest current-platform-reads-current-project
  (let [project-id (uuid/next)
        state      {:current-project-id project-id
                    :penforge-project-settings {project-id :mobile}}]
    (t/is (= :mobile (pf/current-platform state)))
    (t/is (nil? (pf/current-platform (dissoc state :penforge-project-settings))))))

(defn- apply-board-changes
  [platform]
  (let [file-id (uuid/next)
        page-id (uuid/next)
        data    (ctf/make-file-data file-id page-id)
        changes (pf/platform-board-changes platform page-id)]
    {:changes changes
     :page    (-> (cpc/process-changes data changes)
                  (get-in [:pages-index page-id]))}))

(defn- boards
  [page]
  (->> (vals (:objects page))
       (filter #(= :frame (:type %)))
       (remove #(= uuid/zero (:id %)))
       (sort-by :x)))

(t/deftest web-boards
  (let [{:keys [changes page]} (apply-board-changes :web)
        boards (boards page)]
    (t/is (sm/validate cpc/schema:changes changes))
    (t/is (= [["Desktop" 1440 1024] ["Mobile" 390 844]]
             (mapv (juxt :name :width :height) boards)))
    (t/is (every? #(= uuid/zero (:parent-id %)) boards))
    (t/is (< (+ (:x (first boards)) 1440) (:x (second boards))))
    (t/is (empty? (:guides page)))))

(t/deftest mobile-boards-with-safe-area-guides
  (let [{:keys [changes page]} (apply-board-changes :mobile)
        [iphone android] (boards page)
        guides (vals (:guides page))]
    (t/is (sm/validate cpc/schema:changes changes))
    (t/is (= ["iPhone" 390 844] ((juxt :name :width :height) iphone)))
    (t/is (= ["Android" 412 915] ((juxt :name :width :height) android)))
    (t/is (= 2 (count guides)))
    (t/is (every? #(= (:id iphone) (:frame-id %)) guides))
    (t/is (every? #(= :y (:axis %)) guides))
    (t/is (= #{47 810} (into #{} (map :position) guides)))))

(t/deftest unknown-platform-adds-nothing
  (t/is (= [] (pf/platform-board-changes nil (uuid/next)))))

;; --- Create-project panel state

(t/deftest create-button-needs-name-and-platform
  (t/is (false? (create-project/can-create? "" :web)))
  (t/is (false? (create-project/can-create? "   " :mobile)))
  (t/is (false? (create-project/can-create? "Shop" nil)))
  (t/is (false? (create-project/can-create? "Shop" :desktop)))
  (t/is (false? (create-project/can-create? (apply str (repeat 251 "a")) :web)))
  (t/is (true? (create-project/can-create? "Shop" :web)))
  (t/is (true? (create-project/can-create? " Shop " :mobile))))

(t/deftest cards-keyboard-navigation
  (let [values [:web :mobile]]
    (t/is (= :mobile (option-cards/step-value values :web 1)))
    (t/is (= :web (option-cards/step-value values :mobile 1)))
    (t/is (= :mobile (option-cards/step-value values :web -1)))
    (t/is (= :web (option-cards/step-value values nil 1)))
    (t/is (= :mobile (option-cards/step-value values nil -1)))
    (t/is (nil? (option-cards/step-value [] nil 1)))))
