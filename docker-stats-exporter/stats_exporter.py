import docker
import time
import logging
from prometheus_client import start_http_server, Gauge

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Create Prometheus metrics
cpu_usage = Gauge('container_cpu_usage_percent', 'CPU usage in percent', ['container_name'])
memory_usage = Gauge('container_memory_usage_bytes', 'Memory usage in bytes', ['container_name'])
memory_limit = Gauge('container_memory_limit_bytes', 'Memory limit in bytes', ['container_name'])
network_rx_bytes = Gauge('container_network_receive_bytes_total', 'Network bytes received', ['container_name'])
network_tx_bytes = Gauge('container_network_transmit_bytes_total', 'Network bytes transmitted', ['container_name'])

def get_container_stats():
    logging.info("Initializing Docker client")
    client = docker.from_env()
    
    while True:
        try:
            containers = client.containers.list()
            logging.info(f"Found {len(containers)} containers")
            
            for container in containers:
                logging.info(f"Processing container: {container.name}")
                stats = container.stats(stream=False)
                name = container.name
                
                try:
                    # CPU stats
                    cpu_delta = stats['cpu_stats']['cpu_usage']['total_usage'] - stats['precpu_stats']['cpu_usage']['total_usage']
                    system_delta = stats['cpu_stats']['system_cpu_usage'] - stats['precpu_stats']['system_cpu_usage']
                    # On macOS, percpu_usage might not be available, so we'll use a default of 1 CPU
                    num_cpus = len(stats['cpu_stats']['cpu_usage'].get('percpu_usage', [1]))
                    cpu_percent = (cpu_delta / system_delta) * 100.0 * num_cpus
                    cpu_usage.labels(container_name=name).set(cpu_percent)
                    logging.info(f"Container {name} CPU usage: {cpu_percent:.2f}%")
                except Exception as e:
                    logging.error(f"Error processing CPU stats for {name}: {e}")
                
                try:
                    # Memory stats
                    mem_usage = stats['memory_stats']['usage']
                    mem_limit_val = stats['memory_stats']['limit']
                    memory_usage.labels(container_name=name).set(mem_usage)
                    memory_limit.labels(container_name=name).set(mem_limit_val)
                    logging.info(f"Container {name} Memory usage: {mem_usage / 1024 / 1024:.2f}MB")
                except Exception as e:
                    logging.error(f"Error processing memory stats for {name}: {e}")
                
                try:
                    # Network stats
                    if 'networks' in stats:
                        for interface, net_stats in stats['networks'].items():
                            network_rx_bytes.labels(container_name=name).set(net_stats['rx_bytes'])
                            network_tx_bytes.labels(container_name=name).set(net_stats['tx_bytes'])
                            logging.info(f"Container {name} Network stats - RX: {net_stats['rx_bytes'] / 1024:.2f}KB, TX: {net_stats['tx_bytes'] / 1024:.2f}KB")
                    else:
                        logging.warning(f"No network stats available for container {name}")
                except Exception as e:
                    logging.error(f"Error processing network stats for {name}: {e}")
                
        except Exception as e:
            logging.error(f"Error collecting stats: {e}")
            
        time.sleep(5)

if __name__ == '__main__':
    # Start Prometheus HTTP server
    start_http_server(8080)
    logging.info("Prometheus metrics server started on port 8080")
    
    # Start collecting stats
    get_container_stats() 