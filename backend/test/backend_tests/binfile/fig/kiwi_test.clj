;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.binfile.fig.kiwi-test
  (:require
   [app.binfile.fig.kiwi :as kiwi]
   [backend-tests.binfile.fig.fixtures :as fx]
   [clojure.test :as t])
  (:import
   java.io.ByteArrayOutputStream))

(defn- written [f v]
  (let [out (ByteArrayOutputStream.)]
    (f out v)
    (kiwi/buffer (.toByteArray out))))

(defn- validation-code [f]
  (try (f) nil
       (catch clojure.lang.ExceptionInfo cause
         (let [data (ex-data cause)]
           (when (= :validation (:type data)) (:code data))))))

(t/deftest var-uint-round-trips
  (doseq [v [0 1 127 128 300 16384 0x7fffffff 0xffffffff]]
    (t/is (= v (kiwi/read-var-uint (written fx/write-var-uint v))) (str v))))

(t/deftest var-int-uses-zigzag
  (doseq [v [0 1 -1 63 -64 1000 -1000 2147483647 -2147483648]]
    (t/is (= v (kiwi/read-var-int (written fx/write-var-int v))) (str v))))

(t/deftest var-uint64-round-trips
  (doseq [v [0 1 300 (bit-shift-left 1 40) Long/MAX_VALUE]]
    (t/is (= v (kiwi/read-var-uint64 (written fx/write-var-uint64 v))) (str v))))

(t/deftest var-float-keeps-float32-values
  (t/testing "zero takes a single byte"
    (let [bb (written fx/write-var-float 0.0)]
      (t/is (= 1 (.remaining bb)))
      (t/is (= 0.0 (kiwi/read-var-float bb)))))
  (doseq [v [1.0 -3.25 0.5 1234.5 1.0E-3 -7.0E10]]
    (t/is (= (double (float v)) (kiwi/read-var-float (written fx/write-var-float v))) (str v))))

(t/deftest strings-are-utf8-and-zero-terminated
  (t/is (= "héllo ✓" (kiwi/read-string (written fx/write-string "héllo ✓"))))
  (t/testing "an unterminated string is a validation error"
    (t/is (= :invalid-fig-file
             (validation-code #(kiwi/read-string (kiwi/buffer (.getBytes "abc" "UTF-8"))))))))

(t/deftest schema-decodes-definitions-and-types
  (let [schema (kiwi/decode-schema (fx/encode-schema))
        guid   (get-in schema [:index "GUID"])
        node   (get-in schema [:index "NodeChange"])
        paints (some #(when (= "fillPaints" (:name %)) %) (:fields node))]
    (t/is (= :struct (:kind guid)))
    (t/is (= [:uint :uint] (mapv :type (:fields guid))))
    (t/is (= :message (:kind node)))
    (t/is (= "Paint" (:type paints)))
    (t/is (true? (:array? paints)))))

(t/deftest messages-decode-with-the-embedded-schema
  (let [decoders (kiwi/compile-schema (kiwi/decode-schema (fx/encode-schema)))
        value    {:type :NODE_CHANGES
                  :nodeChanges [{:guid {:sessionID 1 :localID 2}
                                 :type :FRAME
                                 :name "Frame"
                                 :visible true
                                 :size {:x 10.0 :y 20.5}
                                 :fillPaints [{:type :SOLID :color {:r 1.0 :g 0.5 :b 0.0 :a 1.0}}]
                                 :textData {:characters "a" :characterStyleIDs [0 1]
                                            :styleOverrideTable [{:styleID 1 :fontSize 12.0}]}
                                 :extra -5}]
                  :blobs [{:bytes (byte-array [1 2 3])}]}
        decoded  (kiwi/decode-message decoders (fx/encode-message value))
        node     (first (:nodeChanges decoded))]
    (t/is (= :NODE_CHANGES (:type decoded)))
    (t/is (= {:sessionID 1 :localID 2} (:guid node)))
    (t/is (= :FRAME (:type node)))
    (t/is (= {:x 10.0 :y 20.5} (:size node)))
    (t/is (= :SOLID (get-in node [:fillPaints 0 :type])))
    (t/is (= 0.5 (get-in node [:fillPaints 0 :color :g])))
    (t/is (= [0 1] (get-in node [:textData :characterStyleIDs])))
    (t/is (= 12.0 (get-in node [:textData :styleOverrideTable 0 :fontSize])))
    (t/is (= -5 (:extra node)))
    (t/is (= [1 2 3] (vec (get-in decoded [:blobs 0 :bytes]))))
    (t/testing "absent message fields stay absent"
      (t/is (not (contains? node :opacity))))))

(t/deftest hostile-payloads-fail-cleanly
  (let [decoders (kiwi/compile-schema (kiwi/decode-schema (fx/encode-schema)))
        good     (fx/encode-message {:type :NODE_CHANGES
                                     :nodeChanges [{:name "x"}]})]
    (t/testing "a truncated message"
      (t/is (= :invalid-fig-file
               (validation-code #(kiwi/decode-message decoders (java.util.Arrays/copyOf good 4))))))
    (t/testing "an unknown field tag"
      (t/is (= :invalid-fig-file
               (validation-code #(kiwi/decode-message decoders (byte-array [99 0]))))))
    (t/testing "an array longer than the payload"
      ;; field 3 of Message is nodeChanges: claim a huge length
      (t/is (= :invalid-fig-file
               (validation-code #(kiwi/decode-message decoders (byte-array [3 0xff 0xff 0xff 0x7f]))))))
    (t/testing "a truncated schema"
      (t/is (= :invalid-fig-file
               (validation-code #(kiwi/decode-schema (java.util.Arrays/copyOf (fx/encode-schema) 10))))))))
