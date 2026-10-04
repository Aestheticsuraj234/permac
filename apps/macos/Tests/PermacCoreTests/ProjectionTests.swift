import XCTest
@testable import PermacCore

final class ProjectionTests: XCTestCase {
    func testUnknownSchemaIsRejected() {
        let raw = #"{"schema_version":99,"event_id":"e","task_id":"t","sequence":1,"timestamp":"t","type":"task.created","payload":{}}"#
        let projection = Ingest.envelope(Data(raw.utf8), into: Projection())
        XCTAssertTrue(projection.schemaError)
        XCTAssertTrue(projection.tasks.isEmpty)
    }

    func testReorderedDeliveryAppliesOnce() {
        let started = #"{"schema_version":1,"event_id":"e1","task_id":"t","sequence":1,"timestamp":"t","type":"tool.started","payload":{"action_id":"a1"}}"#
        let finished = #"{"schema_version":1,"event_id":"e3","task_id":"t","sequence":3,"timestamp":"t","type":"run.finished","payload":{"state":"succeeded"}}"#
        let completed = #"{"schema_version":1,"event_id":"e2","task_id":"t","sequence":2,"timestamp":"t","type":"tool.completed","payload":{"action_id":"a1","state":"verified"}}"#
        var projection = Projection()
        projection = Ingest.envelope(Data(started.utf8), into: projection)
        projection = Ingest.envelope(Data(started.utf8), into: projection)
        projection = Ingest.envelope(Data(finished.utf8), into: projection)
        projection = Ingest.envelope(Data(completed.utf8), into: projection)
        XCTAssertEqual(projection.tasks["t"]?.actions.count, 1)
        XCTAssertEqual(projection.tasks["t"]?.actions["a1"], "verified")
        XCTAssertEqual(projection.tasks["t"]?.state, "succeeded")
        XCTAssertFalse(projection.schemaError)
    }
}
