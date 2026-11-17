;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-actions-test
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [cljs.test :as t :include-macros true]))

(defn- action
  [id & {:as attrs}]
  (merge {:id id
          :label (constantly (name id))
          :scopes #{:context-menu}
          :run (constantly nil)}
         attrs))

(t/deftest get-actions-filters-by-scope-and-visibility-in-order
  (let [registry {:ai/b (action :ai/b :order 2)
                  :ai/a (action :ai/a :order 2)
                  :ai/first (action :ai/first :order 1)
                  :ai/header (action :ai/header :scopes #{:header})
                  :ai/hidden (action :ai/hidden :visible? (constantly false))}]
    (t/is (= [:ai/first :ai/a :ai/b]
             (mapv :id (actions/get-actions registry :context-menu {}))))
    (t/is (= [:ai/header]
             (mapv :id (actions/get-actions registry :header {}))))))

(t/deftest enabled-defaults-to-true
  (t/is (true? (actions/enabled? (action :ai/x) {})))
  (t/is (false? (actions/enabled? (action :ai/x :enabled? :ok) {})))
  (t/is (true? (actions/enabled? (action :ai/x :enabled? :ok) {:ok 1}))))

(t/deftest register-action-validates-and-replaces
  (let [id :ai/test-registered]
    (try
      (actions/register-action! (action id :order 5))
      (actions/register-action! (action id :order 6))
      (t/is (= 6 (:order (get @actions/registry id))))
      (t/is (thrown? js/Error (actions/register-action! {:id id :scopes #{:nowhere}})))
      (finally
        (actions/unregister-action! id)))
    (t/is (not (contains? @actions/registry id)))))

(t/deftest builtin-open-chat-action-is-registered-everywhere
  (let [registry @actions/registry]
    (doseq [scope [:context-menu :main-menu :header :command-palette]]
      (t/is (some #(= :ai/open-chat (:id %)) (actions/get-actions registry scope {}))
            (str scope)))))
