JOBS = {}


def queue_import(shelf):
    job_id = f"job-{len(JOBS) + 1}"
    JOBS[job_id] = {"shelf": shelf, "state": "queued"}
    return {"job": job_id}


def job_state(job_id):
    return JOBS.get(job_id, {"state": "unknown"})
