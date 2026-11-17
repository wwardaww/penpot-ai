;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.binfile.fig.import-test
  "A `.fig` import through the `:import-binfile` job, end to end."
  (:require
   [app.binfile.common :as bfc]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.jobs :as jobs]
   [app.jobs.storage :as js]
   [app.storage :as sto]
   [backend-tests.binfile.fig.fixtures :as fx]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

(defn- run-job!
  "Stage `path` as the resource of an import job and run the handler as
  the runner would."
  [profile path params & {:keys [flags] :or {flags #{:ai}}}]
  (let [staged (js/put-resource th/*system* (:id profile)
                                {:content  (sto/content path)
                                 :filename "package.penpot"
                                 :mtype    "application/zip"})
        job-id (th/create-job* :import-binfile {:profile-id (:id profile)
                                                :resource-id (:resource-id staged)})]
    (with-redefs [cf/flags (into (disj cf/flags :ai) flags)]
      (jobs/invoke (-> th/*system*
                       (assoc ::jobs/name :import-binfile)
                       (assoc ::jobs/params (merge {:project-id (:default-project-id profile)
                                                    :name       "From Figma"
                                                    :version    "fig"}
                                                   params))
                       (assoc ::jobs/context (jobs/make-context (jobs/get-job th/*system* job-id))))))))

(t/deftest a-fig-file-imports-as-one-penpot-file
  (let [profile (th/create-profile* 1)
        result  (run-job! profile (fx/medium-fig!) {})
        file-id (first (:file-ids result))
        file    (bfc/get-file th/*system* file-id)
        media   (th/db-query :file-media-object {:file-id file-id})]

    (t/testing "the job answers with the file and the report"
      (t/is (= 1 (count (:file-ids result))))
      (t/is (= "fig" (:version result)))
      (t/is (= 1 (get-in result [:report :total])))
      (t/is (= "STICKY" (get-in result [:report :unsupported 0 :fig-type]))))

    (t/testing "the file is in the destination project with its name"
      (t/is (= "From Figma" (:name file)))
      (t/is (= (:default-project-id profile) (:project-id file))))

    (t/testing "the image is stored as a media object of the file"
      (t/is (= 1 (count media)))
      (t/is (= [2 1] ((juxt :width :height) (first media))))
      (t/is (some? (sto/get-object (sto/resolve th/*system*) (:media-id (first media))))))

    (t/testing "the pages and components are there"
      (t/is (= 1 (count (get-in file [:data :pages]))))
      (t/is (= 2 (count (get-in file [:data :components])))))))

(t/deftest a-bad-file-fails-cleanly
  (let [profile (th/create-profile* 1)
        path    (fx/temp-file ".fig")
        before  (count (th/db-query :file {:project-id (:default-project-id profile)}))]
    (spit path "not a figma file at all")
    (let [error (try (run-job! profile path {}) nil
                     (catch clojure.lang.ExceptionInfo cause (ex-data cause)))]
      (t/is (= :validation (:type error)))
      (t/is (= :invalid-fig-file (:code error))))
    (t/testing "nothing was created"
      (t/is (= before (count (th/db-query :file {:project-id (:default-project-id profile)})))))))

(t/deftest the-import-needs-the-ai-flag
  (let [profile (th/create-profile* 1)
        error   (try (run-job! profile (fx/medium-fig!) {} :flags #{}) nil
                     (catch clojure.lang.ExceptionInfo cause (ex-data cause)))]
    (t/is (= :restriction (:type error)))
    (t/is (= :feature-disabled (:code error)))))

(t/deftest the-penpot-versions-still-validate
  (let [def (jobs/get-job-def (jobs/get-defs th/*system*) :import-binfile)]
    (t/is (true? ((::jobs/validator def) {:project-id (uuid/next) :name "x" :version 3})))
    (t/is (true? ((::jobs/validator def) {:project-id (uuid/next) :name "x" :version "fig"})))
    (t/is (false? ((::jobs/validator def) {:project-id (uuid/next) :name "x" :version 2})))))
