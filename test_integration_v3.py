#!/usr/bin/env python3
"""
Integration test script v3 - Updated for new Module 1 structure
Supports multi-language testing (Python, Java, Go, C, Ruby, Rust)
"""

import sys
import os
import time
from pathlib import Path
from typing import Iterator

# Add module1_adapter to path
sys.path.insert(0, str(Path(__file__).parent / "module1_adapter" / "src"))

# Import from new structure
from module1_adapter.parsers import get_parser
from module1_adapter.generated import ir_events_pb2
from module1_adapter.generated import ir_events_pb2_grpc
from module1_adapter.core.transport import IREventPublisher
import grpc
from concurrent import futures


class OnDemandIREventStreamService(ir_events_pb2_grpc.IREventStreamServicer):
    """
    gRPC service that parses and streams events on-demand.
    Supports multiple languages via Module 1's parsers.
    """

    def __init__(self):
        self.active = True

    def StreamEvents(self, request: ir_events_pb2.MonitorFileRequest, context) -> Iterator[ir_events_pb2.IREvent]:
        """
        Stream events for a monitored file by parsing it on-demand.
        """
        file_path = request.file_path
        language = request.language or self._detect_language(file_path)

        print(f"[Transport] Client connected, streaming events for {file_path}")
        print(f"[Transport] Language: {language}")

        try:
            # Extract facts from the file using Module 1's parser
            parser = get_parser(language=language, file_path=file_path)
            with open(file_path, 'r') as f:
                content = f.read()
            facts = parser.parse(content, file_path)
            print(f"[Transport] Extracted {len(facts)} facts, streaming...")

            # Convert facts to events and stream them
            publisher = IREventPublisher(language=language)
            for i, fact in enumerate(facts):
                if not context.is_active():
                    print(f"[Transport] Client disconnected after {i} events")
                    break

                event = publisher.publish_fact(fact, file_path)
                yield event

            print(f"[Transport] Finished streaming {len(facts)} events")
            print(f"[Transport] Closing stream")

        except Exception as e:
            print(f"[Transport] Error streaming events: {e}")
            import traceback
            traceback.print_exc()
            raise

    def _detect_language(self, file_path: str) -> str:
        """Detect language from file extension"""
        ext = Path(file_path).suffix
        lang_map = {
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.c': 'c',
            '.rb': 'ruby',
            '.rs': 'rust',
        }
        return lang_map.get(ext, 'python')

    def shutdown(self):
        """Gracefully shutdown the service."""
        self.active = False


def main():
    """
    Start gRPC server that streams events on-demand for multiple languages.
    """
    grpc_port = 50051

    print(f"[Integration Test V3] Starting multi-language gRPC server on port {grpc_port}")
    print(f"[Integration Test V3] Supported: Python, Java, Go, C, Ruby, Rust")

    # Start gRPC server with our custom service
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    service = OnDemandIREventStreamService()
    ir_events_pb2_grpc.add_IREventStreamServicer_to_server(service, server)

    server.add_insecure_port(f'0.0.0.0:{grpc_port}')
    server.start()

    print(f"[Integration Test V3] Server ready on http://127.0.0.1:{grpc_port}")
    print("[Integration Test V3] Module 2 can now connect")
    print("[Integration Test V3] Press Ctrl+C to stop")

    # Keep server alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Integration Test V3] Shutting down...")
        service.shutdown()
        server.stop(0)


if __name__ == "__main__":
    main()
