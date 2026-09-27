const resume = {
    CONTACT: [
        "Jiangyun Zhu",
        "Senior Data Engineer | AI/ML Infrastructure Engineer",
        "San Carlos, CA 94070",
        "(310) 421-8894",
        "jiang.y.z.1015@gmail.com",
        "https://linkedin.com/in/jiangyun-zhu-650b8b167"
    ],
    SUMMARY: "Senior data engineer with a proven track record and 10+ years of experience designing scalable data platforms, distributed data pipelines, analytical systems, metrics infrastructure, and decision-support solutions across AI/ML infrastructure, advertising, messaging, insurance, and e-commerce. Deep technical experience across Python, SQL, PySpark, Apache Spark, Kafka, Flink, ETL/ELT, batch and stream processing, lakehouse architecture, orchestration, cloud data platforms, data quality, lineage, observability, and distributed systems. Progressed from enterprise transactional data engineering to hyperscale product data systems, global data engineering leadership, and AI/ML infrastructure capacity analytics at Meta. Currently focused on GPU/CPU infrastructure telemetry, capacity planning, resource allocation, utilization analytics, training and inference efficiency, distributed AI infrastructure, observability, and AI-assisted analytical systems, combining traditional data engineering with emerging AI infrastructure engineering.",
    SKILLS: [
        "Languages & Data Processing: Python, SQL, PySpark, C#, Bash, Scala, Apache Spark, Apache Flink, Apache Kafka, batch processing, stream processing, CDC",
        "Data Platforms & Architecture: Apache Iceberg, Delta Lake, Parquet, Trino, Presto, Databricks, Snowflake, BigQuery, ETL/ELT, data modeling, distributed systems, data warehouses, data lakes, lakehouse architecture, metrics platforms, decision-support systems",
        "Cloud & Infrastructure: AWS, GCP, Azure, Linux, Docker, Kubernetes, object storage, cloud analytics platforms, GPU scheduling, Slurm, Ray",
        "Data Reliability & Observability: data quality, data lineage, data contracts, SLAs/SLOs, anomaly detection, Prometheus, Grafana, OpenTelemetry, infrastructure telemetry, time-series analytics",
        "AI/ML Infrastructure: GPU/CPU telemetry pipelines, capacity planning analytics, resource utilization metrics, infrastructure observability, workload performance reporting, ML platform operational analytics, AI-assisted investigation workflows"],

    EXPERIENCE: [
        [
            "Meta",
            "Sr Tech Lead Manager, AI/ML Infra Capacity Data",
            "San Francisco Bay Area",
            "Sep 2024 - Present",
            "Led development of data pipelines and analytics platforms supporting AI infrastructure capacity planning, utilization analysis, and operational reporting.",
            "Architected modern cloud-scale data systems using Python, SQL, Spark/PySpark, Kafka, Airflow, AWS/S3, Iceberg, Trino as Primary technologies and Flink, dbt, Databricks, Terraform, Kubernetes, Prometheus/Grafana as Supporting technologies.",
            "Designed distributed data pipelines ingesting CPU/GPU fleet telemetry, training jobs, inference demand, resource allocation, scheduling signals, hardware utilization, and reliability events through Kafka-based event streaming, CDC patterns, and batch ingestion into S3/Iceberg lakehouse tables.",
            "Built scalable batch and streaming processing layers with Spark/PySpark, Flink, Databricks, Trino/Presto, and SQL, transforming raw infrastructure telemetry into curated capacity datasets, utilization metrics, GPU-hour models, and infrastructure capacity reports and operational metrics used by engineering stakeholders.",
            "Implemented orchestration and workflow automation using Airflow to manage pipeline dependencies, retries, SLAs, backfills, partition-aware scheduling, incremental processing, and production data refreshes across training, inference, and infrastructure capacity domains.",
            "Developed reusable Data Modeling frameworks across raw, intermediate, and business-facing layers, including fact tables, dimension tables, aggregate tables, metric layers, and capacity-planning datasets for AI/ML infrastructure decision-making.",
            "Built capacity analytics covering demand forecasting, supply planning, allocation efficiency, transforming raw infrastructure telemetry into curated capacity datasets, utilization metrics, GPU-hour utilization metrics, and infrastructure capacity reports.",
            "Developed fleet observability systems using Prometheus/Grafana-style monitoring, infrastructure telemetry, and analytical dashboards to track CPU/GPU utilization, accelerator availability, memory usage, training throughput, inference demand, hardware failures, and performance regressions.",
            "Engineered streaming analytics with Kafka and Flink to detect real-time infrastructure anomalies, utilization drops, scheduling bottlenecks, capacity constraints, and reliability regressions across large-scale AI/ML workloads.",
            "Built lakehouse-style analytical datasets on AWS S3 and Apache Iceberg, enabling ACID-style table management, schema evolution, time-aware analysis, partition pruning, incremental processing, and efficient access from Spark, Trino/Presto, Databricks, and dbt.",
            "Applied Data Quality controls across critical infrastructure datasets, including schema validation, freshness checks, completeness checks, reconciliation, anomaly detection, metric consistency, duplicate detection, and automated pipeline-health monitoring.",
            "Established Data Lineage and metric-governance practices to trace capacity metrics from raw telemetry and CDC sources through transformation pipelines, modeled datasets, dashboards, and AI-assisted analytical workflows.",
            "Used Terraform and Kubernetes best practices to support reproducible data infrastructure, environment management, scalable deployment patterns, configuration management, and reliable operation of data services and analytics workloads.",
            "Built self-service analytics, dashboards, and investigation tools enabling infrastructure engineers, ML platform teams, and leadership to analyze capacity utilization, GPU efficiency, model-training throughput, inference demand, and resource-allocation tradeoffs.",
            "Developed AI-assisted analytics prototypes and automation workflows for metric exploration, anomaly investigation, root-cause analysis, and infrastructure efficiency analysis.",
            "Partnered with ML infrastructure, training, inference, hardware, networking, storage, capacity engineering, and product teams to translate large-scale infrastructure data into actionable capacity recommendations and optimization strategies."
        ],
        [
            "Meta",
            "Data Engineering Manager",
            "Menlo Park, CA",
            "Dec 2021 - Sep 2024",
            "Led a distributed Data Engineering team across the U.S. and Singapore, building analytical data systems supporting analytics systems used by a large-scale Meta Ads business.",
            "Architected end-to-end data platforms using SQL, Python, Spark/PySpark, Airflow, Trino/Presto, dbt, Databricks, AWS, S3, Iceberg, Kafka, Flink, Terraform, Kubernetes, Prometheus/Grafana, CDC, Data Quality, and Data Lineage practices to support product analytics, experimentation, and business decision-making.",
            "Built scalable ETL/ELT pipelines transforming high-volume advertising events, product interactions, customer lifecycle signals, experiment exposures, and monetization data into trusted analytical datasets and business metrics.",
            "Designed the product's core Data Modeling architecture across raw events, standardized staging datasets, reusable fact and dimension tables, aggregate tables, and business-facing metric layers.",
            "Built lifecycle analytics covering acquisition, activation, engagement, retention, conversion, monetization, revenue, advertiser adoption, product quality, and guardrail performance across the full product lifecycle.",
            "Developed Kafka and Flink-style streaming data patterns for near-real-time product and ads event processing, enabling timely monitoring of product health, advertiser behavior, metric movement, and anomaly detection.",
            "Used Spark/PySpark, Databricks, SQL, and Trino/Presto to process large-scale batch datasets, optimize distributed queries, reduce redundant computation, and support high-performance analytical workloads.",
            "Built transformation layers with dbt-style modular SQL modeling, including staging models, intermediate models, fact tables, incremental models, reusable macros, tests, documentation, and metric definitions.",
            "Implemented Airflow-based orchestration for pipeline scheduling, dependency management, retries, SLA monitoring, backfills, incremental refreshes, and production workflow reliability.",
            "Designed lakehouse-compatible datasets using AWS S3 and Apache Iceberg concepts, supporting partitioned storage, schema evolution, historical analysis, table optimization, and efficient distributed query access.",
            "Built experimentation data pipelines supporting A/B testing, treatment/control analysis, experiment exposure tracking, metric computation, dimensional slicing, statistical evaluation, and launch decision-making for Ads product initiatives.",
            "Established north-star, diagnostic, and guardrail metric frameworks to evaluate product growth while protecting advertiser outcomes, user experience, data quality, system reliability, and long-term revenue performance.",
            "Implemented production-grade Data Quality frameworks covering freshness, completeness, uniqueness, validity, consistency, distribution shifts, reconciliation, and automated anomaly detection.",
            "Developed Data Lineage and documentation standards to trace metrics from source events and CDC pipelines through transformations, modeled datasets, dashboards, and business-facing KPIs.",
            "Used Prometheus/Grafana-style observability to monitor pipeline health, data freshness, workflow failures, runtime trends, resource usage, and downstream metric reliability.",
            "Applied Terraform and Kubernetes practices to support scalable, reproducible, and maintainable data infrastructure across batch, streaming, orchestration, and analytics workloads.",
            "Partnered with Product, Data Science, Engineering, and Ads leadership to convert business goals into data models, metrics, experiments, dashboards, and analytical systems used for product strategy and monetization decisions.",
            "Defined team-wide standards for data architecture, SQL/Python development, distributed processing, orchestration, data quality, data lineage, CI/CD, documentation, code review, and production operations."
        ],
        [
            "Facebook / Meta",
            "Sr. Data Engineer",
            "Menlo Park, CA",
            "Sep 2019 - Dec 2021",
            "Architected analytical data systems for Business Messaging products across Messenger and Instagram, enabling product, growth, data science, and business teams to measure customer-business communication, messaging adoption, engagement, retention, and product quality.",
            "Built large-scale ETL/ELT pipelines using SQL, Python, Presto, Hive, Spark/PySpark, Dataswarm, and Scribe-based event data, transforming high-volume messaging events into trusted analytical datasets and reusable metric layers.",
            "Designed product analytics data models across raw event logs, standardized staging tables, fact tables, dimension tables, aggregated datasets, and business-facing KPIs for Messenger and Instagram messaging products.",
            "Developed measurement frameworks for business messaging funnels, including message creation, send/receive activity, response behavior, account adoption, engagement, retention, and cross-surface usage across Messenger and Instagram.",
            "Built experimentation datasets for A/B testing, experiment exposure tracking, treatment/control analysis, launch-readiness measurement, product adoption metrics, and guardrail metrics to support product-shipping decisions.",
            "Created data-quality and metric-quality guardrails covering freshness, completeness, duplication, schema consistency, event correctness, anomalous metric movement, and downstream dashboard reliability.",
            "Optimized complex Presto/Hive/Spark SQL pipelines through partition pruning, incremental processing, query optimization, dependency-aware scheduling, backfill design, and reusable transformations.",
            "Built self-service analytics datasets and dashboards enabling Product Managers, Data Scientists, Engineers, and Business teams to investigate messaging-product performance without repeated manual data extraction.",
            "Partnered with product, engineering, data science, and growth teams to translate ambiguous product questions into scalable data models, analytical workflows, KPIs, and decision-support systems.",
            "Won 1st Prize in the 2020 DI & DE Hackathon by building a high-impact data solution that improved analytical productivity, data accessibility, or business decision-making for internal stakeholders."
        ],
        [
            "Assurant",
            "Data Engineer",
            "Atlanta, Georgia",
            "Aug 2016 - Sep 2019",
            "Designed and developed transactional and analytical data systems for insurance, warranty, claims, service-contract, and e-commerce business domains, supporting operational reporting, partner analytics, customer insights, and business decision-making.",
            "Built end-to-end ETL/ELT pipelines using SQL, Python, Spark, SQL Server/Azure SQL-style relational systems, and cloud data engineering patterns, integrating transactional, customer, policy, claims, order, payment, product, and partner datasets.",
            "Designed normalized transactional models and analytical data marts to support policy lifecycle, claims processing, e-commerce orders, customer activity, product protection plans, and partner performance analysis.",
            "Developed scalable data transformations across staging, integration, business-rule, reconciliation, and reporting layers, converting complex operational data into clean, analytics-ready datasets.",
            "Built dimensional models including fact tables, dimension tables, slowly changing dimensions, customer/partner views, and aggregated reporting tables for BI and operational analytics.",
            "Implemented production-grade data quality controls covering completeness, accuracy, reconciliation, duplicate detection, referential integrity, schema validation, and exception handling for insurance and e-commerce workflows.",
            "Supported legacy data-system modernization by improving SQL performance, simplifying ETL logic, automating recurring data loads, and preparing datasets for cloud/Lakehouse-style architectures.",
            "Built and maintained reporting datasets for Power BI/Tableau-style dashboards, enabling business users to analyze claims, orders, customer behavior, revenue, operational performance, and service metrics.",
            "Integrated data from relational databases, APIs, files, and third-party partner feeds using batch and incremental-processing patterns, improving reliability of downstream analytics and operational reporting.",
            "Partnered with business analysts, application engineers, QA, product owners, and operations teams to translate insurance and e-commerce requirements into reliable data pipelines, data models, and reporting solutions."
        ],
        [
            "Kearney",
            "Summer Intern",
            "Shanghai, China",
            "2013",
            "Supported management-consulting project teams by collecting, cleaning, processing, and analyzing client, market, operational, and financial data to generate business insights and recommendations.",
            "Built analytical models using SQL, Python/R-style analysis, Excel, statistics, and visualization tools such as Tableau or Power BI to identify trends, patterns, cost drivers, growth opportunities, and operational improvement areas.",
            "Conducted quantitative and qualitative analysis across structured and semi-structured datasets, translating raw information into clear findings for client-facing workstreams.",
            "Prepared executive-ready presentations, charts, and analytical summaries to communicate insights, assumptions, methodology, and recommendations to consulting teams and stakeholders.",
            "Collaborated with consultants to structure ambiguous business problems, define analysis plans, validate assumptions, and synthesize data-backed recommendations.",
            "Developed early foundation in business analytics, data storytelling, consulting problem-solving, client communication, and analytical modeling, later applied to enterprise-scale Data Engineering roles."]
    ],
    EDUCATION: [
        [
            "Georgia Institute of Technology",
            [
                [
                    "Master of Science",
                    "Computer Science"
                ],
            ],
            "2016"
        ],
        [
            "University of Missouri Columbia",
            [
                [
                    "Master of Science",
                    "Artificial Intelligence"
                ],
            ],
            "2015"
        ],
        [
            "East China University of Science and Technology",
            [
                [
                    "Bachelor of Engineering",
                    "Data Engineering"
                ],
            ],
            "2013"
        ],
    ],
};

const resume1 = {
    CONTACT: [
        "Triet Le",
        "Senior Salesforce Developer | Salesforce Platform Engineer",
        "San Carlos, CA 94070",
        "(480) 666-1845",
        "trietle1997@outlook.com",
        "https://www.linkedin.com/in/trietle97/"
    ],
    SUMMARY: "Senior Salesforce Developer with 7+ years of Salesforce and enterprise technology experience designing, developing, integrating, and supporting scalable CRM solutions across healthcare, financial services, cloud technology, SaaS, consulting, and regulated enterprise environments. Strong hands-on experience with Apex, Lightning Web Components, Visualforce, Salesforce Flow, SOQL, REST APIs, asynchronous Apex, Sales Cloud, Service Cloud, Experience Cloud, OmniStudio, data migration, and Salesforce integration architecture. Experienced delivering healthcare and financial-services use cases involving secure customer and member service workflows, case management, provider and account interactions, billing and transaction-related processes, data privacy, role-based access, auditability, and integration with external enterprise platforms. Experienced modernizing legacy automation, building event-driven integrations, designing secure metadata-driven applications, supporting data governance and compliance-sensitive processes, and developing Agentforce-aware business automation. Strong background in Agile delivery, Salesforce DevOps, production troubleshooting, performance optimization, and collaborating with business stakeholders, architects, product owners, QA teams, administrators, and support teams to deliver secure, maintainable, and production-ready Salesforce solutions.",
    SKILLS: [
        "Salesforce Platform: Sales Cloud, Service Cloud, Experience Cloud, Lightning Experience, Salesforce Platform, Salesforce CPQ, Revenue Cloud, Salesforce Data Cloud, Education Cloud, Nonprofit Cloud, Manufacturing Cloud",
        "Healthcare & Life Sciences Salesforce: Health Cloud, Patient 360, Provider 360, Patient/Member Profiles, Provider Relationships, Care Coordination, Referral Management, Patient Services, Healthcare Case Management, Consent-Aware Communication, Healthcare Service Operations, Healthcare CRM Workflows, Regulated Case Management",
        "Healthcare Security & Compliance: HIPAA-Aware Salesforce Design, PHI-Aware Access Controls, Data Privacy Controls, Role-Based Access, Permission Sets, Permission Set Groups, Field-Level Security, Record-Level Security, Sharing Rules, Audit Trail Design, Sensitive Healthcare Data Protection, Compliance Reporting Support",
        "Salesforce Development: Apex, Apex Triggers, Lightning Web Components (LWC), Aura Components, Visualforce, SOQL, SOSL, Batch Apex, Queueable Apex, Scheduled Apex, Future Methods, JavaScript, Asynchronous Apex",
        "AI/ML Infrastructure: GPU/CPU telemetry pipelines, capacity planning analytics, resource utilization metrics, infrastructure observability, workload performance reporting, ML platform operational analytics, AI-assisted investigation workflows"
    ],
    EXPERIENCE: [
        [
            "Docker, Inc",
            "Senior Salesforce Developer",
            "Seattle, Washington, United States",
            "Dec 2024 - Present",
            "Led development of data pipelines and analytics platforms supporting AI infrastructure capacity planning, utilization analysis, and operational reporting.",
            "Architected modern cloud-scale data systems using Python, SQL, Spark/PySpark, Kafka, Airflow, AWS/S3, Iceberg, Trino as Primary technologies and Flink, dbt, Databricks, Terraform, Kubernetes, Prometheus/Grafana as Supporting technologies.",
            "Designed distributed data pipelines ingesting CPU/GPU fleet telemetry, training jobs, inference demand, resource allocation, scheduling signals, hardware utilization, and reliability events through Kafka-based event streaming, CDC patterns, and batch ingestion into S3/Iceberg lakehouse tables.",
            "Built scalable batch and streaming processing layers with Spark/PySpark, Flink, Databricks, Trino/Presto, and SQL, transforming raw infrastructure telemetry into curated capacity datasets, utilization metrics, GPU-hour models, and infrastructure capacity reports and operational metrics used by engineering stakeholders.",
            "Implemented orchestration and workflow automation using Airflow to manage pipeline dependencies, retries, SLAs, backfills, partition-aware scheduling, incremental processing, and production data refreshes across training, inference, and infrastructure capacity domains.",
            "Developed reusable Data Modeling frameworks across raw, intermediate, and business-facing layers, including fact tables, dimension tables, aggregate tables, metric layers, and capacity-planning datasets for AI/ML infrastructure decision-making.",
            "Built capacity analytics covering demand forecasting, supply planning, allocation efficiency, transforming raw infrastructure telemetry into curated capacity datasets, utilization metrics, GPU-hour utilization metrics, and infrastructure capacity reports.",
            "Developed fleet observability systems using Prometheus/Grafana-style monitoring, infrastructure telemetry, and analytical dashboards to track CPU/GPU utilization, accelerator availability, memory usage, training throughput, inference demand, hardware failures, and performance regressions.",
            "Engineered streaming analytics with Kafka and Flink to detect real-time infrastructure anomalies, utilization drops, scheduling bottlenecks, capacity constraints, and reliability regressions across large-scale AI/ML workloads.",
            "Built lakehouse-style analytical datasets on AWS S3 and Apache Iceberg, enabling ACID-style table management, schema evolution, time-aware analysis, partition pruning, incremental processing, and efficient access from Spark, Trino/Presto, Databricks, and dbt.",
            "Applied Data Quality controls across critical infrastructure datasets, including schema validation, freshness checks, completeness checks, reconciliation, anomaly detection, metric consistency, duplicate detection, and automated pipeline-health monitoring.",
            "Established Data Lineage and metric-governance practices to trace capacity metrics from raw telemetry and CDC sources through transformation pipelines, modeled datasets, dashboards, and AI-assisted analytical workflows.",
            "Used Terraform and Kubernetes best practices to support reproducible data infrastructure, environment management, scalable deployment patterns, configuration management, and reliable operation of data services and analytics workloads.",
            "Built self-service analytics, dashboards, and investigation tools enabling infrastructure engineers, ML platform teams, and leadership to analyze capacity utilization, GPU efficiency, model-training throughput, inference demand, and resource-allocation tradeoffs.",
            "Developed AI-assisted analytics prototypes and automation workflows for metric exploration, anomaly investigation, root-cause analysis, and infrastructure efficiency analysis.",
            "Partnered with ML infrastructure, training, inference, hardware, networking, storage, capacity engineering, and product teams to translate large-scale infrastructure data into actionable capacity recommendations and optimization strategies."
        ],
        [
            "Amazon Web Services (AWS)",
            "Senior Salesforce Developer",
            "Seattle, Washington, United States",
            "Jul 2023 - Dec 2024",
            "Led a distributed Data Engineering team across the U.S. and Singapore, building analytical data systems supporting analytics systems used by a large-scale Meta Ads business.",
            "Architected end-to-end data platforms using SQL, Python, Spark/PySpark, Airflow, Trino/Presto, dbt, Databricks, AWS, S3, Iceberg, Kafka, Flink, Terraform, Kubernetes, Prometheus/Grafana, CDC, Data Quality, and Data Lineage practices to support product analytics, experimentation, and business decision-making.",
            "Built scalable ETL/ELT pipelines transforming high-volume advertising events, product interactions, customer lifecycle signals, experiment exposures, and monetization data into trusted analytical datasets and business metrics.",
            "Designed the product's core Data Modeling architecture across raw events, standardized staging datasets, reusable fact and dimension tables, aggregate tables, and business-facing metric layers.",
            "Built lifecycle analytics covering acquisition, activation, engagement, retention, conversion, monetization, revenue, advertiser adoption, product quality, and guardrail performance across the full product lifecycle.",
            "Developed Kafka and Flink-style streaming data patterns for near-real-time product and ads event processing, enabling timely monitoring of product health, advertiser behavior, metric movement, and anomaly detection.",
            "Used Spark/PySpark, Databricks, SQL, and Trino/Presto to process large-scale batch datasets, optimize distributed queries, reduce redundant computation, and support high-performance analytical workloads.",
            "Built transformation layers with dbt-style modular SQL modeling, including staging models, intermediate models, fact tables, incremental models, reusable macros, tests, documentation, and metric definitions.",
            "Implemented Airflow-based orchestration for pipeline scheduling, dependency management, retries, SLA monitoring, backfills, incremental refreshes, and production workflow reliability.",
            "Designed lakehouse-compatible datasets using AWS S3 and Apache Iceberg concepts, supporting partitioned storage, schema evolution, historical analysis, table optimization, and efficient distributed query access.",
            "Built experimentation data pipelines supporting A/B testing, treatment/control analysis, experiment exposure tracking, metric computation, dimensional slicing, statistical evaluation, and launch decision-making for Ads product initiatives.",
            "Established north-star, diagnostic, and guardrail metric frameworks to evaluate product growth while protecting advertiser outcomes, user experience, data quality, system reliability, and long-term revenue performance.",
            "Implemented production-grade Data Quality frameworks covering freshness, completeness, uniqueness, validity, consistency, distribution shifts, reconciliation, and automated anomaly detection.",
            "Developed Data Lineage and documentation standards to trace metrics from source events and CDC pipelines through transformations, modeled datasets, dashboards, and business-facing KPIs.",
            "Used Prometheus/Grafana-style observability to monitor pipeline health, data freshness, workflow failures, runtime trends, resource usage, and downstream metric reliability.",
            "Applied Terraform and Kubernetes practices to support scalable, reproducible, and maintainable data infrastructure across batch, streaming, orchestration, and analytics workloads.",
            "Partnered with Product, Data Science, Engineering, and Ads leadership to convert business goals into data models, metrics, experiments, dashboards, and analytical systems used for product strategy and monetization decisions.",
            "Defined team-wide standards for data architecture, SQL/Python development, distributed processing, orchestration, data quality, data lineage, CI/CD, documentation, code review, and production operations."
        ],
        [
            "Amazon Web Services (AWS)",
            "Salesforce Developer",
            "Seattle, Washington, United States",
            "Oct 2021 - Jul 2023",
            "Architected analytical data systems for Business Messaging products across Messenger and Instagram, enabling product, growth, data science, and business teams to measure customer-business communication, messaging adoption, engagement, retention, and product quality.",
            "Built large-scale ETL/ELT pipelines using SQL, Python, Presto, Hive, Spark/PySpark, Dataswarm, and Scribe-based event data, transforming high-volume messaging events into trusted analytical datasets and reusable metric layers.",
            "Designed product analytics data models across raw event logs, standardized staging tables, fact tables, dimension tables, aggregated datasets, and business-facing KPIs for Messenger and Instagram messaging products.",
            "Developed measurement frameworks for business messaging funnels, including message creation, send/receive activity, response behavior, account adoption, engagement, retention, and cross-surface usage across Messenger and Instagram.",
            "Built experimentation datasets for A/B testing, experiment exposure tracking, treatment/control analysis, launch-readiness measurement, product adoption metrics, and guardrail metrics to support product-shipping decisions.",
            "Created data-quality and metric-quality guardrails covering freshness, completeness, duplication, schema consistency, event correctness, anomalous metric movement, and downstream dashboard reliability.",
            "Optimized complex Presto/Hive/Spark SQL pipelines through partition pruning, incremental processing, query optimization, dependency-aware scheduling, backfill design, and reusable transformations.",
            "Built self-service analytics datasets and dashboards enabling Product Managers, Data Scientists, Engineers, and Business teams to investigate messaging-product performance without repeated manual data extraction.",
            "Partnered with product, engineering, data science, and growth teams to translate ambiguous product questions into scalable data models, analytical workflows, KPIs, and decision-support systems.",
            "Won 1st Prize in the 2020 DI & DE Hackathon by building a high-impact data solution that improved analytical productivity, data accessibility, or business decision-making for internal stakeholders."
        ],
        [
            "Deloitte Consulting",
            "Salesforce Developer",
            "Gilbert, Arizona, United States",
            "Feb 2019 - Sep 2021",
            "Designed and developed transactional and analytical data systems for insurance, warranty, claims, service-contract, and e-commerce business domains, supporting operational reporting, partner analytics, customer insights, and business decision-making.",
            "Built end-to-end ETL/ELT pipelines using SQL, Python, Spark, SQL Server/Azure SQL-style relational systems, and cloud data engineering patterns, integrating transactional, customer, policy, claims, order, payment, product, and partner datasets.",
            "Designed normalized transactional models and analytical data marts to support policy lifecycle, claims processing, e-commerce orders, customer activity, product protection plans, and partner performance analysis.",
            "Developed scalable data transformations across staging, integration, business-rule, reconciliation, and reporting layers, converting complex operational data into clean, analytics-ready datasets.",
            "Built dimensional models including fact tables, dimension tables, slowly changing dimensions, customer/partner views, and aggregated reporting tables for BI and operational analytics.",
            "Implemented production-grade data quality controls covering completeness, accuracy, reconciliation, duplicate detection, referential integrity, schema validation, and exception handling for insurance and e-commerce workflows.",
            "Supported legacy data-system modernization by improving SQL performance, simplifying ETL logic, automating recurring data loads, and preparing datasets for cloud/Lakehouse-style architectures.",
            "Built and maintained reporting datasets for Power BI/Tableau-style dashboards, enabling business users to analyze claims, orders, customer behavior, revenue, operational performance, and service metrics.",
            "Integrated data from relational databases, APIs, files, and third-party partner feeds using batch and incremental-processing patterns, improving reliability of downstream analytics and operational reporting.",
            "Partnered with business analysts, application engineers, QA, product owners, and operations teams to translate insurance and e-commerce requirements into reliable data pipelines, data models, and reporting solutions."
        ],
        [
            "Arizona State University - W. P. Carey School of Business",
            "IT Support Specialist",
            "Tempe, Arizona, United States",
            "Jun 2016 - Dec 2018",
            "Supported management-consulting project teams by collecting, cleaning, processing, and analyzing client, market, operational, and financial data to generate business insights and recommendations.",
            "Built analytical models using SQL, Python/R-style analysis, Excel, statistics, and visualization tools such as Tableau or Power BI to identify trends, patterns, cost drivers, growth opportunities, and operational improvement areas.",
            "Conducted quantitative and qualitative analysis across structured and semi-structured datasets, translating raw information into clear findings for client-facing workstreams.",
            "Prepared executive-ready presentations, charts, and analytical summaries to communicate insights, assumptions, methodology, and recommendations to consulting teams and stakeholders.",
            "Collaborated with consultants to structure ambiguous business problems, define analysis plans, validate assumptions, and synthesize data-backed recommendations.",
            "Developed early foundation in business analytics, data storytelling, consulting problem-solving, client communication, and analytical modeling, later applied to enterprise-scale Data Engineering roles."
        ],
        [
            "EY",
            "Risk Advisory Intern",
            "Greater Phoenix Area",
            "Jun 2018 - Aug 2018",
            "Supported management-consulting project teams by collecting, cleaning, processing, and analyzing client, market, operational, and financial data to generate business insights and recommendations.",
            "Built analytical models using SQL, Python/R-style analysis, Excel, statistics, and visualization tools such as Tableau or Power BI to identify trends, patterns, cost drivers, growth opportunities, and operational improvement areas.",
            "Conducted quantitative and qualitative analysis across structured and semi-structured datasets, translating raw information into clear findings for client-facing workstreams.",
            "Prepared executive-ready presentations, charts, and analytical summaries to communicate insights, assumptions, methodology, and recommendations to consulting teams and stakeholders.",
            "Collaborated with consultants to structure ambiguous business problems, define analysis plans, validate assumptions, and synthesize data-backed recommendations.",
            "Developed early foundation in business analytics, data storytelling, consulting problem-solving, client communication, and analytical modeling, later applied to enterprise-scale Data Engineering roles."
        ]
    ],
    CERTIFICATIONS: [
        "Salesforce Certified Platform Developer II",
        "Salesforce Certified Application Architect",
        "Salesforce Certified Data Architecture & Management Designer",
        "Salesforce Certified Sharing and Visibility Designer",
        "Vlocity Platform Developer",
        "Salesforce Certified Platform App Builder Certification",
        "Salesforce Certified Administrator (SCA)",
        "Salesforce Certified Platform Developer I",
    ],
    EDUCATION: [
        [
            "W. P. Carey School of Business - Arizona State University",
            [
                [
                    "Bachelor of Science (B.S.)",
                    "Business Analytics"
                ],
                [
                    "Bachelor's degree",
                    "Computer and Information Systems Security/Information Assurance"
                ]

            ],
            "2015 - 2018"
        ],
    ]
};

